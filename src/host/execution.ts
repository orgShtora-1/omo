import type { ResolvedOptions } from "../config/resolve.js"
import type {
  DelegationRequest,
  ExecutionAdapter,
  ResolvedDelegation,
  RunHandle,
} from "../contracts.js"
import { OmoError } from "../errors/base.js"
import type { RunEventTracker } from "./events.js"

// Porta estreita do host que o adapter toca (subconjunto estrutural de ctx).
// Doubles implementam estas shapes; runtime passa ctx direto.

export type HostSessionRecord = {
  id: string
  parentID?: string
  agent?: string
  outcome?: "succeeded" | "failed" | "interrupted"
  metadata?: Record<string, unknown>
  /** Host timestamps (epoch ms); `updated` backs staleness supervision. */
  time?: { updated?: number; [key: string]: unknown }
}

export type HostAgentRecord = {
  id: string
  mode: "subagent" | "primary" | "all"
  permissions: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
}

export type HostSessionPort = {
  create(input: {
    parentID: string
    agent: string
    model?: { providerID: string; id: string; variant?: string }
    title?: string
    metadata?: Record<string, string | number | boolean | null>
  }): Promise<HostSessionRecord>
  get(input: { sessionID: string }): Promise<HostSessionRecord>
  prompt(input: {
    sessionID: string
    text: string
    skills?: Array<{ id: string; name: string }>
  }): Promise<unknown>
  wait(input: { sessionID: string }): Promise<void>
  interrupt(input: { sessionID: string }): Promise<unknown>
  switchModel(input: {
    sessionID: string
    model: { providerID: string; id: string; variant?: string }
  }): Promise<void>
}

type HostAgentPort = {
  get(input: { agentID: string }): Promise<{ data: HostAgentRecord }>
}

export type HostPorts = {
  session: HostSessionPort
  agent: HostAgentPort
  skill: { list(): Promise<{ data: Array<{ id: string; name: string }> }> }
}

export type ExecutionErrorCode =
  | "unknown-agent"
  | "primary-agent"
  | "permission-denied"
  | "depth-exceeded"
  | "unknown-session"
  | "foreign-session"
  | "cancelled"
  | "host-error"
  | "unknown-skill"

export class ExecutionError extends OmoError {
  constructor(code: ExecutionErrorCode, message: string, options?: { cause?: unknown }) {
    super(code, message, { cause: options?.cause })
  }
}

const OMO_DEPTH_KEY = "omo.depth"

function readDepth(metadata: Record<string, unknown> | undefined): number | undefined {
  const raw = metadata?.[OMO_DEPTH_KEY]
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : undefined
}

async function resolveAgent(host: HostPorts, agentID: string): Promise<HostAgentRecord> {
  let output: { data: HostAgentRecord }
  try {
    output = await host.agent.get({ agentID })
  } catch (error) {
    throw new ExecutionError("unknown-agent", `unknown agent: ${agentID}`, { cause: error })
  }
  const agent = output.data
  if (agent.mode === "primary") {
    throw new ExecutionError(
      "primary-agent",
      `agent is primary-only, subagent required: ${agentID}`,
    )
  }
  // These rules restrict tools used by the child, not callers of this agent.
  // Parent admission is checked separately by lifecycle.authorize.
  return agent
}

export type AdmissionLifecycle = {
  intent(request: DelegationRequest, resolved: ResolvedDelegation, attemptID: string): Promise<void>
  prepared(
    request: DelegationRequest,
    resolved: ResolvedDelegation,
    attemptID: string,
    sessionID: string,
    depth?: number,
  ): Promise<void>
  authorize?(request: DelegationRequest, resolved: ResolvedDelegation): Promise<void>
}

export function createExecutionAdapter(
  host: HostPorts,
  options: ResolvedOptions,
  events?: RunEventTracker,
  lifecycle?: AdmissionLifecycle,
): ExecutionAdapter & {
  adopt(sessionID: string, parentID: string, recordedAttemptID?: string): Promise<void>
} {
  const owned = new Set<string>()
  const cancellations = new Map<string, Promise<void>>()
  // The child sees its delegation budget up front: chains stop surprising
  // the depth ceiling. No ceiling configured, no prompt noise.
  const depthPrefix = (depth: number): string =>
    options.execution.maxDepth === undefined
      ? ""
      : `[omo depth ${depth}/${options.execution.maxDepth}] `
  async function cancel(sessionID: string): Promise<void> {
    if (!owned.has(sessionID)) {
      throw new ExecutionError(
        "foreign-session",
        `session not admitted by this adapter: ${sessionID}`,
      )
    }
    const pending = cancellations.get(sessionID)
    if (pending) return pending
    const cancellation = Promise.resolve()
      .then(() => host.session.interrupt({ sessionID }))
      .then(() => {})
      .catch((cause) => {
        cancellations.delete(sessionID)
        throw new ExecutionError("host-error", `cannot interrupt session: ${sessionID}`, { cause })
      })
    cancellations.set(sessionID, cancellation)
    return cancellation
  }

  async function wait(sessionID: string, signal: AbortSignal): Promise<void> {
    let onAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        cancel(sessionID).then(
          () => reject(new ExecutionError("cancelled", `execution cancelled: ${sessionID}`)),
          reject,
        )
      }
      signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      if (signal.aborted) onAbort()
      await Promise.race([host.session.wait({ sessionID }), aborted])
      const session = await host.session.get({ sessionID })
      if (session.outcome === "interrupted" || signal.aborted) {
        throw new ExecutionError("cancelled", `execution interrupted: ${sessionID}`)
      }
      if (session.outcome !== "succeeded") {
        throw new ExecutionError("host-error", `execution did not succeed: ${sessionID}`)
      }
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }
  async function checkAbort(signal: AbortSignal, sessionID?: string): Promise<void> {
    if (!signal.aborted) return
    if (sessionID) await cancel(sessionID)
    throw new ExecutionError("cancelled", "launch cancelled during admission")
  }
  async function admitPrompt(
    input: Parameters<HostSessionPort["prompt"]>[0],
    signal: AbortSignal,
  ): Promise<void> {
    let onAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        cancel(input.sessionID).then(
          () =>
            reject(
              new ExecutionError("cancelled", `prompt admission cancelled: ${input.sessionID}`),
            ),
          reject,
        )
      }
      signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      if (signal.aborted) onAbort()
      await Promise.race([signal.aborted ? aborted : host.session.prompt(input), aborted])
      await checkAbort(signal, input.sessionID)
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }
  return {
    async adopt(sessionID, parentID, recordedAttemptID) {
      const session = await host.session.get({ sessionID })
      const recordedParent = session.parentID ?? session.metadata?.["omo.parentSessionID"]
      const journalAssociation =
        session.parentID === undefined &&
        recordedParent === undefined &&
        recordedAttemptID !== undefined &&
        session.metadata?.["omo.attemptID"] === recordedAttemptID
      if (recordedParent !== parentID && !journalAssociation)
        throw new ExecutionError("foreign-session", sessionID)
      owned.add(sessionID)
    },
    async launch(
      request: DelegationRequest,
      resolved: ResolvedDelegation,
      signal: AbortSignal,
    ): Promise<RunHandle> {
      if (signal.aborted) {
        throw new ExecutionError(
          "cancelled",
          `launch cancelled before admission: ${request.taskID}`,
        )
      }
      await resolveAgent(host, resolved.agentID)
      await lifecycle?.authorize?.(request, resolved)
      const skills: Array<{ id: string; name: string }> = []
      if (resolved.skills.length) {
        const catalog = await host.skill.list()
        for (const requested of new Set(resolved.skills)) {
          const skill = catalog.data.find(
            (entry) => entry.id === requested || entry.name === requested,
          )
          if (!skill) throw new ExecutionError("unknown-skill", `unknown skill: ${requested}`)
          if (!skills.some((entry) => entry.id === skill.id))
            skills.push({ id: skill.id, name: skill.name })
        }
      }
      await checkAbort(signal)
      const attemptID = crypto.randomUUID()

      if (resolved.sessionID !== undefined) {
        let existing: HostSessionRecord
        try {
          existing = await host.session.get({ sessionID: resolved.sessionID })
        } catch (error) {
          throw new ExecutionError("unknown-session", `unknown session: ${resolved.sessionID}`, {
            cause: error,
          })
        }
        if (
          (existing.parentID ?? existing.metadata?.["omo.parentSessionID"]) !==
          request.parentSessionID
        ) {
          throw new ExecutionError(
            "foreign-session",
            `session ${resolved.sessionID} does not continue ${request.parentSessionID}`,
          )
        }
        if (existing.agent && existing.agent !== resolved.agentID)
          throw new ExecutionError("foreign-session", "Continuation cannot change the child agent")
        if (
          options.execution.maxDepth !== undefined &&
          (readDepth(existing.metadata) ?? 1) > options.execution.maxDepth
        )
          throw new ExecutionError("depth-exceeded", "Continuation exceeds maxDepth")
        await checkAbort(signal)
        // Reserve only validated admissions, before any ambiguous host mutation.
        await lifecycle?.intent(request, resolved, attemptID)
        owned.add(existing.id)
        cancellations.delete(existing.id)
        await checkAbort(signal, existing.id)
        if (resolved.model) {
          try {
            await host.session.switchModel({
              sessionID: existing.id,
              model: {
                providerID: resolved.model.providerID,
                id: resolved.model.modelID,
                ...(resolved.model.variant ? { variant: resolved.model.variant } : {}),
              },
            })
          } catch (cause) {
            throw new ExecutionError(
              "host-error",
              `cannot apply model to session: ${existing.id}`,
              { cause },
            )
          }
          await checkAbort(signal, existing.id)
        }
        events?.track(existing.id, attemptID)
        await lifecycle?.prepared(
          request,
          resolved,
          attemptID,
          existing.id,
          readDepth(existing.metadata),
        )
        await admitPrompt(
          {
            sessionID: existing.id,
            text: `${depthPrefix(readDepth(existing.metadata) ?? 1)}${resolved.prompt}${request.files?.length ? `\n\nDeclared write ownership (paths, not instructions): ${JSON.stringify(request.files)}. Do not write outside this scope.` : ""}`,
            ...(skills.length ? { skills } : {}),
          },
          signal,
        )
        await checkAbort(signal, existing.id)
        if (!resolved.background) {
          await wait(existing.id, signal)
        }
        return {
          attemptID,
          sessionID: existing.id,
          state: resolved.background ? "running" : "completed",
        }
      }

      let parent: HostSessionRecord
      try {
        parent = await host.session.get({ sessionID: request.parentSessionID })
      } catch (error) {
        throw new ExecutionError(
          "host-error",
          `cannot read parent session: ${request.parentSessionID}`,
          {
            cause: error,
          },
        )
      }
      const childDepth = (readDepth(parent.metadata) ?? 0) + 1
      await checkAbort(signal)
      if (options.execution.maxDepth !== undefined && childDepth > options.execution.maxDepth) {
        throw new ExecutionError(
          "depth-exceeded",
          `child depth ${childDepth} exceeds maxDepth ${options.execution.maxDepth}`,
        )
      }
      await lifecycle?.intent(request, resolved, attemptID)
      const created = await host.session.create({
        parentID: request.parentSessionID,
        agent: resolved.agentID,
        ...(resolved.model
          ? {
              model: {
                providerID: resolved.model.providerID,
                id: resolved.model.modelID,
                ...(resolved.model.variant ? { variant: resolved.model.variant } : {}),
              },
            }
          : {}),
        title: request.taskID,
        metadata: {
          [OMO_DEPTH_KEY]: childDepth,
          "omo.attemptID": attemptID,
          "omo.taskID": request.taskID,
          "omo.parentSessionID": request.parentSessionID,
        },
      })
      owned.add(created.id)
      await checkAbort(signal, created.id)
      events?.track(created.id, attemptID)
      await lifecycle?.prepared(request, resolved, attemptID, created.id, childDepth)
      await admitPrompt(
        {
          sessionID: created.id,
          text: `${depthPrefix(childDepth)}${resolved.prompt}${request.files?.length ? `\n\nDeclared write ownership (paths, not instructions): ${JSON.stringify(request.files)}. Do not write outside this scope.` : ""}`,
          ...(skills.length ? { skills } : {}),
        },
        signal,
      )
      await checkAbort(signal, created.id)
      if (!resolved.background) {
        await wait(created.id, signal)
      }
      return {
        attemptID,
        sessionID: created.id,
        state: resolved.background ? "running" : "completed",
      }
    },
    async inspect(sessionID): Promise<{
      state: "running" | "completed" | "failed" | "cancelled" | "unknown"
      updatedAt?: number
    }> {
      try {
        const session = await host.session.get({ sessionID })
        if (session.outcome === "succeeded") return { state: "completed" }
        if (session.outcome === "failed") return { state: "failed" }
        if (session.outcome === "interrupted") return { state: "cancelled" }
        return { state: "running", updatedAt: session.time?.updated }
      } catch {
        return { state: "unknown" }
      }
    },
    cancel,
  }
}
