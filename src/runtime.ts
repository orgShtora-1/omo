import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { profiles } from "./agents/prompts"
import type { ResolvedOptions } from "./config/resolve"
import { mountContext } from "./context/compaction"
import type {
  DelegationRequest,
  PlanEvent,
  ResolvedDelegation,
  RunHandle,
  Scope,
} from "./contracts"
import { createDelegationPolicy } from "./delegation/policy"
import { scoreSkills } from "./delegation/skills"
import { isDetachReason, RuntimeDetach } from "./execution/detach"
import { openRunJournal, type RunRecord } from "./execution/journal"
import { createResultNotifier } from "./execution/notifications"
import { createOsResultSink, withOsNotifications } from "./execution/os-notifications"
import { abortableSleep } from "./execution/retry"
import { createScheduler } from "./execution/scheduler"
import { createRunEventTracker } from "./host/events"
import { createExecutionAdapter } from "./host/execution"
import { authorizeParent } from "./host/permissions"
import { createPlan } from "./plans/model"
import { type RuntimeServices, registerPlanTools, type TaskInput } from "./plans/tools"
import { transition } from "./plans/transitions"
import { verifyStep } from "./plans/verification"
import { acquireProjectLock } from "./runtime/lock"
import { fetchSkillAudits } from "./skills/audits"
import { type FilesystemSkill, readAgentsCatalog } from "./skills/catalog"
import { ensureSkillCoverage } from "./skills/ensure"
import { installSkill } from "./skills/installer"
import { type HostSkillEntry, mergeCatalogs } from "./skills/merge"
import { reconcileAndSave } from "./state/reconcile"
import { openPlanRepository } from "./state/repository"
import { createTelemetry } from "./telemetry/events"

type BoundRequest = DelegationRequest & { planID?: string; stepID?: string; files?: string[] }
export type MountedRuntime = (() => Promise<void>) & {
  services: RuntimeServices
  repository: ReturnType<typeof openPlanRepository>
  scopeFor(parentID: string): Promise<Scope>
}

// Durable state (lock, plans.sqlite, runs.sqlite) lives in `stateHome`, the
// caller-supplied per-project state directory under the OmO home.
// Single-owner lock per project state directory; see ./runtime/lock for reload semantics.

export async function mountRuntime(
  ctx: Plugin.Context,
  stateHome: string,
  options: ResolvedOptions,
): Promise<MountedRuntime> {
  await mkdir(stateHome, { recursive: true })
  const unlock = await acquireProjectLock(join(stateHome, "runtime.lock"))
  const repository = openPlanRepository(join(stateHome, "plans.sqlite"))
  const journal = openRunJournal(join(stateHome, "runs.sqlite"))
  const tracker = createRunEventTracker()
  const telemetry = createTelemetry(
    ctx.storage,
    JSON.stringify([ctx.location.project.id, ctx.location.directory]),
  )
  const running = new Set<Promise<unknown>>()
  const recoveredReservations = new Map<string, () => void>()
  const lifecycleController = new AbortController()
  // Background delegations detach from the initiating tool-call signal: an
  // interrupted parent turn must not cancel durable child work (ADR-0013).
  const detachedSignal = new AbortController().signal
  let closed = false
  let mutation: Promise<unknown> = Promise.resolve()
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = mutation.then(fn, fn)
    mutation = next.catch(() => {})
    return next
  }
  async function scopeFor(parentID: string): Promise<Scope> {
    const parent = await ctx.session.get({ sessionID: parentID })
    if (parent.projectID !== ctx.location.project.id)
      throw new Error("foreign-project: parent session does not belong to this runtime")
    return {
      projectID: parent.projectID,
      locationID: ctx.location.directory,
      parentSessionID: parentID,
    }
  }
  async function change(parentID: string, planID: string, event: PlanEvent) {
    return serial(async () => {
      const scope = await scopeFor(parentID)
      const plan = await repository.load(scope, planID)
      if (!plan) throw new Error(`unknown-plan: ${planID}`)
      const next = transition(plan, event)
      await repository.save(scope, next, plan.revision)
      return next
    })
  }
  const adapter = createExecutionAdapter(ctx, options, tracker, {
    authorize: (request, resolved) => authorizeParent(ctx, request, resolved),
    async intent(request, resolved, attemptID) {
      journal.intent(attemptID, request, resolved)
    },
    async prepared(request, resolved, attemptID, sessionID, depth) {
      journal.prepared(attemptID, sessionID)
      const session = await ctx.session.get({ sessionID })
      journal.details(attemptID, {
        depth,
        effectiveModel: session.model
          ? {
              providerID: session.model.providerID,
              modelID: session.model.id,
              ...(session.model.variant ? { variant: session.model.variant } : {}),
            }
          : undefined,
      })
      const bound = request as BoundRequest
      if (bound.planID && bound.stepID)
        await change(request.parentSessionID, bound.planID, {
          id: `claim:${attemptID}`,
          at: Date.now(),
          type: "claim",
          stepID: bound.stepID,
          attempt: {
            attemptID,
            sessionID,
            parentSessionID: request.parentSessionID,
            agentID: resolved.agentID,
            ...(resolved.model ? { model: resolved.model } : {}),
          },
        })
    },
  })
  const notify = createResultNotifier(
    journal,
    withOsNotifications(
      (notice) => ctx.session.synthetic(notice),
      createOsResultSink(options.os_notifications),
    ),
  )
  async function finish(record: RunRecord, state: "completed" | "failed" | "cancelled") {
    const bound = record.request as BoundRequest
    const planID = bound.planID
    const stepID = bound.stepID
    let reason: string | undefined
    if (planID && stepID) {
      await serial(async () => {
        const scope = await scopeFor(bound.parentSessionID)
        const plan = await repository.load(scope, planID)
        const step = plan?.steps.find((item) => item.id === stepID)
        if (
          !plan ||
          !step ||
          step.state !== "running" ||
          step.attempts.at(-1)?.attemptID !== record.attemptID
        )
          return
        let event: PlanEvent
        if (state === "completed") {
          event = {
            id: `finish:${record.attemptID}`,
            at: Date.now(),
            type: "execution-finished",
            stepID,
            attemptID: record.attemptID,
          }
        } else if (state === "cancelled") {
          event = {
            id: `finish:${record.attemptID}`,
            at: Date.now(),
            type: "cancel",
            stepID,
          }
        } else {
          event = {
            id: `finish:${record.attemptID}`,
            at: Date.now(),
            type: "fail",
            stepID,
            reason: "Native child execution failed; inspect session before resume",
          }
        }
        if (event.type === "fail") reason = event.reason
        await repository.save(scope, transition(plan, event), plan.revision)
      })
    }
    const terminal = journal.terminal(
      record.attemptID,
      state,
      record.error,
      reason ?? record.reason,
    )
    recoveredReservations.get(record.attemptID)?.()
    recoveredReservations.delete(record.attemptID)
    const sessionID = record.sessionID
    if (!sessionID) throw new Error("unresolved session")
    await telemetry.recordRunEvent(
      {
        attemptID: record.attemptID,
        sessionID,
        state,
        eventID: `finish:${record.attemptID}`,
      },
      {
        at: Date.now(),
        ...(record.resolved.model
          ? { model: `${record.resolved.model.providerID}/${record.resolved.model.modelID}` }
          : {}),
      },
    )
    await notify(terminal)
  }
  async function observe(record: RunRecord, signal: AbortSignal) {
    if (!record.sessionID) throw new Error("unresolved session")
    await adapter.adopt(record.sessionID, record.request.parentSessionID, record.attemptID)
    // Staleness is seeded from the host's own last-update timestamp: a child
    // that died before a restart is reaped on its first poll instead of
    // polling "running" forever and reserving capacity (ADR-0016).
    let lastChanged: number | undefined
    for (;;) {
      const inspected = await adapter.inspect(record.sessionID)
      const state = inspected.state
      if (state === "unknown") {
        journal.block(record.attemptID, "Host session unknown; explicit reconciliation required")
        throw new Error("unknown-session: explicit reconciliation required")
      }
      if (state !== "running") {
        await finish(record, state)
        if (state !== "completed") throw new Error(`execution-${state}: ${record.sessionID}`)
        return
      }
      if (inspected.updatedAt !== undefined && inspected.updatedAt !== lastChanged) {
        lastChanged = Math.max(lastChanged ?? 0, inspected.updatedAt)
      }
      if (
        lastChanged !== undefined &&
        Date.now() - lastChanged >= options.execution.staleTimeoutMs
      ) {
        // No observable host progress inside the stale window: cancel, then
        // terminalize whatever the host reports so the slot is never leaked.
        await adapter.cancel(record.sessionID)
        const after = await adapter.inspect(record.sessionID)
        if (after.state === "running" || after.state === "unknown") {
          journal.block(
            record.attemptID,
            `Stale child showed no host progress for ${Math.round((Date.now() - lastChanged) / 1000)}s and cancellation was not confirmed`,
          )
          throw new Error(`stale-child: ${record.sessionID}`)
        }
        await finish(record, after.state)
        throw new Error(`stale-child: ${record.sessionID}`)
      }
      if (signal.aborted) {
        // Graceful teardown stops observation only; the record stays
        // "admitted" so the next runtime instance reconciles the child.
        if (isDetachReason(signal.reason)) return
        await adapter.cancel(record.sessionID)
        // Keep the reservation until native interruption is observable.
        const inspected = await adapter.inspect(record.sessionID)
        if (inspected.state === "running" || inspected.state === "unknown") {
          journal.block(record.attemptID, "Cancellation not confirmed; reservation retained")
          throw new Error("cancellation-unconfirmed")
        }
        await finish(record, inspected.state)
        throw signal.reason ?? new Error("cancelled")
      }
      await abortableSleep(100, signal).catch((error) => {
        if (!signal.aborted) throw error
      })
    }
  }
  const admissions = new Map<
    string,
    { resolve(handle: RunHandle): void; reject(error: unknown): void }
  >()
  const keyFor = (request: DelegationRequest) =>
    JSON.stringify([request.parentSessionID, request.taskID])
  const scheduler = createScheduler(
    options.execution,
    async (request, resolved, signal) => {
      const admission = admissions.get(keyFor(request))
      let handle: RunHandle
      try {
        handle = await adapter.launch(request, { ...resolved, background: true }, signal)
        journal.admitted(handle.attemptID)
        admission?.resolve(handle)
        await observe(journal.get(handle.attemptID), signal)
        return { ...handle, state: "completed" }
      } catch (error) {
        admission?.reject(error)
        // Persisted intent/prepared/blocked records are never automatically
        // retried and never reserve capacity: retrySafe pins their taskID
        // until explicit reconciliation, so a failed launch cannot leak a
        // capacity slot (ADR-0016).
        throw error
      }
    },
    async (request) => !journal.list().some((record) => keyFor(record.request) === keyFor(request)),
  )
  function supervise(promise: Promise<unknown>) {
    running.add(promise)
    void promise.catch(() => {}).finally(() => running.delete(promise))
  }
  async function resolveTask(
    parentID: string,
    input: TaskInput,
  ): Promise<{ request: BoundRequest; resolved: ResolvedDelegation }> {
    const scope = await scopeFor(parentID)
    if (!!input.planID !== !!input.stepID)
      throw new Error("planID and stepID must be supplied together")
    if (input.planID) {
      const plan = await repository.load(scope, input.planID)
      const step = plan?.steps.find((step) => step.id === input.stepID)
      if (!plan || !step) throw new Error("unknown-plan-step")
      if (step.state !== "pending" || plan.cancelledAt !== undefined)
        throw new Error(`step-not-ready: ${step.state}`)
      if (
        step.dependencies.some(
          (id) => plan.steps.find((item) => item.id === id)?.state !== "completed",
        )
      )
        throw new Error("dependencies-incomplete")
    }
    const request: BoundRequest = {
      projectID: scope.projectID,
      parentSessionID: parentID,
      taskID: input.planID ? `${input.planID}:${input.stepID}` : input.taskID,
      route: input.route,
      prompt: input.prompt,
      skills: input.skills ?? [],
      background: input.background ?? true,
      ...(input.sessionID ? { sessionID: input.sessionID } : {}),
      ...(input.explicitModel ? { explicitModel: input.explicitModel } : {}),
      ...(input.planID ? { planID: input.planID, stepID: input.stepID } : {}),
      ...(input.files ? { files: input.files } : {}),
    }
    const [agents, models, skills] = await Promise.all([
      ctx.agent.list({}),
      ctx.model.list({}),
      ctx.skill.list(),
    ])
    const hostEntries: HostSkillEntry[] = skills.data.map((skill) => ({
      id: skill.id,
      name: skill.name,
      ...("description" in skill && typeof skill.description === "string"
        ? { description: skill.description }
        : {}),
    }))
    // Best-effort filesystem supplement: the host already discovers project
    // `.agents/skills`, but disk frontmatter can carry richer descriptions for
    // scoring. Missing directory or read failure skips FS, never delegation.
    const projectDir = (ctx.location as { directory?: unknown } | undefined)?.directory
    let fsSkills: FilesystemSkill[] = []
    if (typeof projectDir === "string" && projectDir !== "") {
      try {
        fsSkills = await readAgentsCatalog(projectDir)
      } catch {
        fsSkills = []
      }
    }
    const { catalog: merged } = mergeCatalogs(hostEntries, fsSkills)
    const recommended = scoreSkills(input.prompt, input.route.id, merged)
    const policy = createDelegationPolicy(options, {
      agents: agents.data,
      models: models.data.flatMap((model) => [
        { providerID: model.providerID, modelID: model.id },
        ...Object.keys(model.variants ?? {}).map((variant) => ({
          providerID: model.providerID,
          modelID: model.id,
          variant,
        })),
      ]),
      skills: merged,
      recommendSkills: () => recommended.map((item) => item.id),
    })
    let resolved = policy.resolve(request)
    if (
      !resolved.model &&
      (Object.keys(options.execution.providerLimits).length > 0 ||
        Object.keys(options.execution.modelLimits).length > 0)
    ) {
      // Pin the public host default before scheduling so default and explicit
      // requests reserve the same provider/model capacity. Do not guess from
      // catalog ordering or bypass policy validation for inherited models.
      const agent = await ctx.agent.get({ agentID: resolved.agentID })
      const model = agent.data.model ?? (await ctx.session.get({ sessionID: parentID })).model
      if (!model?.providerID || !model.id)
        throw new Error(
          "indeterminate-host-model: providerLimits/modelLimits require a known model; supply explicitModel or configure the agent or parent session model",
        )
      resolved = policy.resolve({
        ...request,
        explicitModel: {
          providerID: model.providerID,
          modelID: model.id,
          ...(model.variant ? { variant: model.variant } : {}),
        },
      })
    }
    // Auto-install coverage never breaks delegation: unexpected errors become
    // an install-failed entry, and freshly installed skills stay out of the
    // host prompt this run (the host revalidates against its own catalog and
    // throws unknown-skill for anything it does not know yet).
    const installCwd =
      typeof projectDir === "string" && projectDir !== "" ? projectDir : process.cwd()
    try {
      const coverage = await ensureSkillCoverage({
        prompt: input.prompt,
        routeID: input.route.id,
        merged,
        hostIds: hostEntries.map((entry) => entry.id),
        autoInstall: options.skills.autoInstall,
        requireAuditPass: options.skills.requireAuditPass,
        strictAudits: options.skills.strictAudits,
        getAudits: (skillId) => fetchSkillAudits(skillId, fetch),
        install: (hit) =>
          installSkill({ ...hit, cwd: installCwd, packageManager: options.runtime.packageManager }),
        confirm: async (text: string) => {
          const result = await ctx.session.prompt(
            { sessionID: parentID, text },
            { signal: new AbortSignal() },
          )
          // The host returns the user's response; treat truthy as confirmation
          return Boolean(result)
        },
      })
      resolved.installedSkills = coverage.installedSkills
    } catch {
      resolved.installedSkills = [
        { id: input.prompt, source: "skills.sh", outcome: "install-failed" },
      ]
    }
    {
      const known = new Set<string>()
      for (const entry of hostEntries) {
        known.add(entry.id)
        known.add(entry.name)
      }
      resolved = { ...resolved, skills: resolved.skills.filter((id) => known.has(id)) }
    }
    resolved.skillReasons = resolved.skills.map((id) => {
      const skill = skills.data.find((entry) => entry.id === id)
      const matches = (values: string[]) =>
        values.some((value) => value === id || value === skill?.name)
      if (matches(request.skills)) return { id, source: "explicit" as const }
      if (matches(options.skills.required)) return { id, source: "required" as const }
      return {
        id,
        source: "recommended" as const,
        score: recommended.find((entry) => entry.id === id)?.score,
      }
    })
    const writable =
      options.profiles.find((profile) => profile.id === resolved.agentID)?.allowWrite ??
      profiles.find((profile) => profile.id === resolved.agentID)?.write ??
      true
    request.files = writable
      ? (input.files?.map((file) => resolve(ctx.location.directory, file)) ?? ["**"])
      : []
    await authorizeParent(ctx, request, resolved)
    if (!journal.retrySafe(parentID, request.taskID))
      throw new Error(`unreconciled-attempt: ${request.taskID}`)
    return { request, resolved }
  }
  const services: RuntimeServices = {
    async delegate(parentID, input, signal) {
      if (closed) throw new Error("runtime unloaded")
      const { request, resolved } = await resolveTask(parentID, input)
      if (
        input.sessionID &&
        journal.unresolved().some((record) => record.sessionID === input.sessionID)
      )
        throw new Error("session-already-running: reconcile before continuation")
      const key = keyFor(request)
      if (admissions.has(key)) throw new Error("task-already-scheduled")
      const admitted = new Promise<RunHandle>((resolve, reject) =>
        admissions.set(key, { resolve, reject }),
      )
      // Attach immediately, including foreground calls which await native completion.
      void admitted.catch(() => {})
      const run = scheduler.schedule(
        request,
        resolved,
        request.background ? detachedSignal : signal,
      )
      supervise(run)
      void run
        .catch((error) => admissions.get(key)?.reject(error))
        .finally(() => admissions.delete(key))
      return request.background ? admitted : run
    },
    async batch(parentID, inputs, signal) {
      const ids = new Set<string>()
      const files = new Set<string>()
      for (const input of inputs) {
        const id = input.planID ? `${input.planID}:${input.stepID}` : input.taskID
        if (ids.has(id)) throw new Error("duplicate-task-in-batch")
        ids.add(id)
        for (const file of input.files ?? []) {
          const path = resolve(ctx.location.directory, file)
          const canonical = process.platform === "win32" ? path.toLowerCase() : path
          if (files.has(canonical)) throw new Error(`ownership-conflict: ${file}`)
          files.add(canonical)
        }
      }
      // Validate every dependency/model/permission before admitting any batch member.
      await Promise.all(inputs.map((input) => resolveTask(parentID, input)))
      return Promise.all(inputs.map((input) => services.delegate(parentID, input, signal)))
    },
    async create(parentID, id, steps) {
      const scope = await scopeFor(parentID)
      const plan = createPlan({
        id,
        projectID: scope.projectID,
        parentSessionID: parentID,
        at: Date.now(),
        steps,
      })
      await repository.save(scope, plan, null)
      return plan
    },
    async status(parentID) {
      const scope = await scopeFor(parentID)
      const plans = await repository.list(scope)
      for (const plan of plans)
        await serial(() => reconcileAndSave(scope, plan.id, repository, adapter, Date.now()))
      return {
        plans: await repository.list(scope),
        runs: journal
          .list()
          .filter((record) => record.request.parentSessionID === parentID)
          .map(({ request, resolved, ...record }) => ({
            ...record,
            taskID: request.taskID,
            agentID: resolved.agentID,
            model: resolved.model,
            skills: resolved.skills,
            skillReasons: resolved.skillReasons ?? [],
            installedSkills: resolved.installedSkills ?? [],
            depth: record.depth,
            maxDepth: options.execution.maxDepth,
            effectiveModel: record.effectiveModel ?? null,
            elapsedMs:
              record.startedAt === undefined
                ? null
                : Math.max(0, (record.finishedAt ?? Date.now()) - record.startedAt),
          })),
        scheduler: scheduler.status(),
        diagnostics: await telemetry.collectDiagnostics(),
      }
    },
    async compact(parentID, sessionID) {
      if (closed) throw new Error("runtime unloaded")
      const target = sessionID ?? parentID
      if (target === parentID) {
        await scopeFor(parentID)
      } else if (
        !journal
          .unresolved()
          .some(
            (record) => record.request.parentSessionID === parentID && record.sessionID === target,
          )
      ) {
        throw new Error(`foreign-session: compact only sessions owned by ${parentID}`)
      }
      await ctx.session.compact({ sessionID: target })
      return services.status(parentID)
    },
    async cancel(parentID, planID) {
      const records = journal
        .unresolved()
        .filter(
          (record) =>
            record.request.parentSessionID === parentID &&
            (!planID || (record.request as BoundRequest).planID === planID),
        )
      if (planID)
        await change(parentID, planID, {
          id: crypto.randomUUID(),
          at: Date.now(),
          type: "cancel-parent",
        })
      else scheduler.cancel(parentID)
      await Promise.all(
        records.map(async (record) => {
          if (!record.sessionID) {
            // No native work exists; free the taskID so it can be retried.
            journal.terminal(
              record.attemptID,
              "cancelled",
              "Cancelled before admission",
              "Cancelled before admission",
            )
            return
          }
          try {
            await adapter.adopt(record.sessionID, parentID)
          } catch {
            journal.terminal(
              record.attemptID,
              "cancelled",
              "Cancelled; adoption failed",
              "Cancelled; adoption failed",
            )
            return
          }
          await adapter.cancel(record.sessionID)
          const inspected = await adapter.inspect(record.sessionID)
          if (inspected.state === "running" || inspected.state === "unknown") {
            // Native interruption is not observable (hung or vanished
            // session). The caller asked to forget this task, so free the
            // taskID instead of pinning it forever.
            journal.terminal(
              record.attemptID,
              "cancelled",
              "Cancelled; native terminal state not confirmed",
              "Cancelled; native terminal state not confirmed",
            )
            return
          }
          await finish(
            record,
            inspected.state === "completed"
              ? "completed"
              : inspected.state === "failed"
                ? "failed"
                : "cancelled",
          )
        }),
      )
      return services.status(parentID)
    },
    async resume(parentID, planID, stepID) {
      const scope = await scopeFor(parentID)
      await serial(() => reconcileAndSave(scope, planID, repository, adapter, Date.now()))
      if (stepID) {
        if (!journal.retrySafe(parentID, `${planID}:${stepID}`))
          throw new Error("unreconciled-attempt: cannot resume ambiguous execution")
        await change(parentID, planID, {
          id: crypto.randomUUID(),
          at: Date.now(),
          type: "resume",
          stepID,
        })
      }
      return services.status(parentID)
    },
    async verify(parentID, planID, stepID, evidence, waiver) {
      const plan = await repository.load(await scopeFor(parentID), planID)
      const step = plan?.steps.find((step) => step.id === stepID)
      if (!step) throw new Error("unknown-plan-step")
      const result = verifyStep(step, evidence, waiver, {
        verifyArtifacts: options.execution.verifyArtifacts,
        projectRoot: ctx.location.directory,
        attemptID: step.attempts.at(-1)?.attemptID,
        seenEvidenceIDs: (plan?.steps ?? [])
          .filter((item) => item.id !== stepID)
          .flatMap((item) => item.evidence.map((entry) => entry.id)),
      })
      if (!result.ok) throw new Error(result.reason)
      return change(parentID, planID, {
        id: crypto.randomUUID(),
        at: Date.now(),
        type: "complete",
        stepID,
        evidence,
        ...(waiver ? { waiver } : {}),
      })
    },
  }
  const disposers: Array<() => Promise<void> | void> = []
  async function disposeRuntime() {
    const errors: unknown[] = []
    const attempt = async (operation: () => Promise<unknown> | unknown) => {
      try {
        await operation()
      } catch (error) {
        errors.push(error)
      }
    }
    closed = true
    lifecycleController.abort(new RuntimeDetach())
    await attempt(() => scheduler.dispose())
    for (const dispose of disposers.reverse()) await attempt(dispose)
    await Promise.allSettled([...running])
    await attempt(() => mutation)
    await attempt(() => journal.close())
    await attempt(() => repository.close())
    await attempt(unlock)
    if (errors.length) throw new AggregateError(errors, "OmO runtime cleanup failed")
  }
  try {
    // Migrate every legacy inbox ID before any recovery notifier can drain a parent.
    journal.migrateNotifications()
    // Recover observations before tools become available. Never re-submit a prompt.
    for (const record of journal.unresolved()) {
      const sessionID = record.sessionID
      if (!sessionID || record.phase === "blocked") {
        // Blocked and intent-only records own no observable native work to
        // supervise, so they never reserve capacity; retrySafe keeps their
        // taskID pinned until explicit reconciliation (omo plan cancel).
        if (record.phase !== "blocked")
          journal.block(
            record.attemptID,
            "Crash during admission; native prompt acceptance is ambiguous, no automatic retry",
          )
        continue
      }
      const state = (await adapter.inspect(sessionID)).state
      if (state === "unknown") {
        journal.block(record.attemptID, "Native session unknown after restart")
        continue
      }
      if (state !== "running") {
        await finish(record, state)
        continue
      }
      // Genuinely running child: adoption validates ownership; a failed
      // adoption blocks the record instead of failing the whole mount.
      try {
        await adapter.adopt(sessionID, record.request.parentSessionID, record.attemptID)
      } catch (error) {
        journal.block(
          record.attemptID,
          `Adoption failed after restart: ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      // A supervised child reserves the runtime conservatively until native
      // state is terminal; observe() releases the reservation via finish().
      recoveredReservations.set(
        record.attemptID,
        scheduler.reserve(record.attemptID, record.request, record.resolved),
      )
      supervise(observe(record, lifecycleController.signal))
    }
    for (const record of journal.list())
      if (
        ["completed", "failed", "cancelled"].includes(record.phase) &&
        record.notification === "pending"
      ) {
        // Preserve the old per-attempt inbox identity across an upgrade with
        // an ambiguous acknowledgement; already admitted messages must not replay.
        await notify(record)
      }
    const tools = await registerPlanTools(ctx, services)
    disposers.push(() => tools.dispose())
    disposers.push(
      await mountContext(ctx, repository, scopeFor, 12000, {
        preemptive: options.preemptive_compaction,
      }),
    )
    const eventsController = new AbortController()
    const eventLoop = (async () => {
      for await (const event of ctx.event.subscribe({ signal: eventsController.signal })) {
        if (eventsController.signal.aborted) break
        const normalized = tracker.accept(event as Parameters<typeof tracker.accept>[0])
        if (normalized) await telemetry.recordRunEvent(normalized, { at: Date.now() })
        if (event.type === "session.execution.interrupted") {
          const parentID = (event as { data: { sessionID: string } }).data.sessionID
          // Only the interrupted session's foreground children are cancelled;
          // background children outlive the parent turn (ADR-0013).
          scheduler.cancel(parentID, (request) => !request.background)
        }
      }
    })()
    // Stream is advisory; recovery relies on journal + inspect, never on missed events.
    supervise(eventLoop)
    disposers.push(() => {
      eventsController.abort()
    })
  } catch (error) {
    try {
      await disposeRuntime()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "OmO runtime setup failed")
    }
    throw error
  }
  let cleanupPromise: Promise<void> | undefined
  const cleanup = (() => (cleanupPromise ??= disposeRuntime())) as MountedRuntime
  cleanup.services = services
  cleanup.repository = repository
  cleanup.scopeFor = scopeFor
  return cleanup
}
