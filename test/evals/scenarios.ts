/**
 * Behavioural eval scenarios for @shtora/omo.
 *
 * Every scenario drives the shipped seam directly and asserts an invariant the
 * product promises. None of them re-implements the behaviour under test, and none
 * of them asserts against a mock of it: a scenario that agreed with a fake would
 * prove nothing about the plugin a user runs.
 *
 * All scenarios are deterministic and offline. Nothing here needs paid inference,
 * a live host, a network, a git repository or a real project layout, so the suite
 * is safe to run in the default gates. A scenario that ever needs an authorized
 * live gate declares `requires` and degrades instead of pretending to pass.
 *
 * The `LEDGER` is the falsifiable coverage claim: every behaviour listed there
 * must be proven by a scenario that actually ran. Adding a behaviour to the
 * ledger without a scenario fails the suite.
 */
import { expect } from "bun:test"
import type { Evidence, Plan, PlanEvent, PlanStepInput, TaskAttempt } from "../../src/contracts"
import { buildBlockedPanel } from "../../src/diagnostics/panel"
import { diagnose } from "../../src/doctor/diagnose"
import { buildRevisionLinkage } from "../../src/evidence/revision"
import { openRunJournal } from "../../src/execution/journal"
import { createPlan, PlanError } from "../../src/plans/model"
import { transition } from "../../src/plans/transitions"
import type { EvalScenario } from "./runner"

/**
 * Bumped to 2 when revision-linked evidence joined the ledger: the suite now also
 * claims that a stored revision is a claim, not an observation, and that only a
 * probe can move it off "asserted".
 */
export const SUITE_VERSION = 2

/** Behaviours this suite claims to prove. Every entry needs a passing scenario. */
export const LEDGER = [
  "plan.completion-never-follows-model-success-alone",
  "plan.documentation-only-steps-need-an-explicit-waiver",
  "plan.evidence-must-state-the-command-and-exit-code",
  "plan.evidence-must-state-the-code-revision",
  "plan.human-evidence-names-its-reviewer",
  "plan.artifacts-carry-a-content-hash",
  "plan.evidence-cannot-be-carried-across-attempts",
  "plan.evidence-cannot-be-reused-by-another-step",
  "plan.completion-stamps-the-current-attempt",
  "plan.steps-cannot-leave-the-legal-transition-graph",
  "plan.dependencies-gate-claiming",
  "plan.one-attempt-cannot-own-a-step-twice",
  "plan.foreign-parents-cannot-claim-our-steps",
  "journal.unresolved-attempts-block-readmission",
  "journal.terminal-outcome-clears-unresolved-state",
  "panel.malformed-input-never-reads-as-clear",
  "panel.blocked-runs-surface-their-recorded-reason",
  "panel.in-flight-phases-are-not-reported-as-blocked",
  "doctor.absent-git-blocks-only-git-dependent-features",
  "doctor.unverifiable-observations-never-read-as-all-clear",
  "doctor.pending-asks-are-observed-facts-not-authorizations",
  "revision.a-declared-revision-is-asserted-until-a-probe-confirms-it",
  "revision.divergent-revisions-never-read-as-linked",
  "revision.probe-failure-is-unverifiable-never-contradicted",
  "revision.a-waived-step-is-never-revision-linked",
] as const

const AT = 1_700_000_000_000
const steps: readonly PlanStepInput[] = [
  { id: "one", objective: "First step", dependencies: [] },
  { id: "two", objective: "Second step", dependencies: ["one"] },
]

const seed = (): Plan =>
  createPlan({ id: "p1", projectID: "proj", parentSessionID: "parent", at: AT, steps })

let sequence = 0
const eventID = () => `e${++sequence}`
const at = () => AT + sequence

const attempt = (
  attemptID: string,
  parentSessionID = "parent",
): Omit<TaskAttempt, "state" | "startedAt" | "finishedAt"> => ({
  attemptID,
  sessionID: `child-${attemptID}`,
  parentSessionID,
  agentID: "OMO_worker",
})

const apply = (plan: Plan, ...events: readonly PlanEvent[]): Plan =>
  events.reduce((current, event) => transition(current, event), plan)

/** Drives a fresh plan's first step to `verifying` so completion is reachable. */
const verifying = (attemptID = "attempt-1"): Plan =>
  apply(
    seed(),
    { id: eventID(), at: at(), type: "claim", stepID: "one", attempt: attempt(attemptID) },
    {
      id: eventID(),
      at: at(),
      type: "execution-finished",
      stepID: "one",
      attemptID,
    },
  )

/** Evidence bound to a command, its exit code, a revision and its origin. */
const bound = (id = "ev-1", overrides: Partial<Evidence> = {}): Evidence => ({
  id,
  description: "the executed gate",
  command: "bun run check",
  exitCode: 0,
  revision: "0f1e2d3c",
  origin: "auto",
  ...overrides,
})

/** The exact event `complete` builds, so a scenario can override only `stepID`. */
type CompleteEvent = Extract<PlanEvent, { type: "complete" }>

/** Runs a transition expected to fail and returns the PlanError it produced. */
const rejected = (plan: Plan, event: PlanEvent): PlanError => {
  try {
    transition(plan, event)
  } catch (error) {
    if (error instanceof PlanError) return error
    throw new Error(`expected a PlanError, observed ${String(error)}`)
  }
  throw new Error(`expected the transition to be rejected: ${event.type}`)
}

const complete = (evidence: readonly Evidence[], waiver?: string): CompleteEvent => ({
  id: eventID(),
  at: at(),
  type: "complete",
  stepID: "one",
  evidence: [...evidence],
  ...(waiver === undefined ? {} : { waiver }),
})

const panelOptions = { parentSessionID: "parent", now: AT }

const REVISION = "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567"
/** A plan whose stored evidence declares `revision`, as the plan store requires. */
const linked = (revision: string = REVISION): Plan =>
  transition(verifying(), complete([bound("ev-1", { revision })]))

export const SCENARIOS: readonly EvalScenario[] = [
  {
    id: "plan.completion-requires-bound-evidence",
    version: 1,
    title: "A finished step cannot complete on model success alone",
    covers: ["plan.completion-never-follows-model-success-alone"],
    run: () => {
      const plan = verifying()
      expect(plan.steps[0]?.state).toBe("verifying")
      expect(rejected(plan, complete([])).code).toBe("verification-required")
    },
  },
  {
    id: "plan.documentation-only-steps-need-a-waiver",
    version: 1,
    title: "An empty evidence set completes only with an explicit justified waiver",
    covers: ["plan.documentation-only-steps-need-an-explicit-waiver"],
    run: () => {
      const plan = verifying()
      expect(rejected(plan, complete([], "   ")).code).toBe("verification-required")
      const completed = transition(plan, complete([], "docs only, no artifact"))
      const step = completed.steps[0]
      expect(step?.state).toBe("completed")
      expect(step?.evidence).toEqual([])
      expect(step?.waiver).toBe("docs only, no artifact")
    },
  },
  {
    id: "plan.evidence-states-command-and-exit-code",
    version: 1,
    title: "Evidence without the executed command or its exit code is rejected",
    covers: ["plan.evidence-must-state-the-command-and-exit-code"],
    run: () => {
      const plan = verifying()
      expect(rejected(plan, complete([{ id: "ev-1", description: "it passed" }])).code).toBe(
        "invalid-evidence",
      )
      expect(rejected(plan, complete([bound("ev-1", { command: undefined })])).code).toBe(
        "invalid-evidence",
      )
      expect(rejected(plan, complete([bound("ev-1", { exitCode: undefined })])).code).toBe(
        "invalid-evidence",
      )
      expect(transition(plan, complete([bound()])).steps[0]?.state).toBe("completed")
    },
  },
  {
    id: "plan.evidence-states-the-code-revision",
    version: 1,
    title: "Evidence without the revision it was observed on is rejected",
    covers: ["plan.evidence-must-state-the-code-revision"],
    run: () => {
      const plan = verifying()
      expect(rejected(plan, complete([bound("ev-1", { revision: "  " })])).code).toBe(
        "invalid-evidence",
      )
      const completed = transition(plan, complete([bound()]))
      expect(completed.steps[0]?.evidence[0]?.revision).toBe("0f1e2d3c")
    },
  },
  {
    id: "plan.human-evidence-names-its-reviewer",
    version: 1,
    title: "Evidence claimed as human review must name the reviewer",
    covers: ["plan.human-evidence-names-its-reviewer"],
    run: () => {
      const plan = verifying()
      expect(rejected(plan, complete([bound("ev-1", { origin: "human" })])).code).toBe(
        "invalid-evidence",
      )
      expect(
        rejected(plan, complete([bound("ev-1", { origin: "reviewer-typed" as "auto" })])).code,
      ).toBe("invalid-evidence")
      const completed = transition(
        plan,
        complete([bound("ev-1", { origin: "human", reviewer: "second-pair-eyes" })]),
      )
      expect(completed.steps[0]?.evidence[0]?.reviewer).toBe("second-pair-eyes")
    },
  },
  {
    id: "plan.artifacts-carry-a-content-hash",
    version: 1,
    title: "Evidence naming an artifact must carry its sha256",
    covers: ["plan.artifacts-carry-a-content-hash"],
    run: () => {
      const plan = verifying()
      expect(rejected(plan, complete([bound("ev-1", { artifact: "logs.txt" })])).code).toBe(
        "invalid-evidence",
      )
      expect(
        rejected(plan, complete([bound("ev-1", { artifact: "logs.txt", artifactHash: "abc" })]))
          .code,
      ).toBe("invalid-evidence")
      const hash = "a".repeat(64)
      const completed = transition(
        plan,
        complete([bound("ev-1", { artifact: "logs.txt", artifactHash: hash })]),
      )
      expect(completed.steps[0]?.evidence[0]?.artifactHash).toBe(hash)
    },
  },
  {
    id: "plan.evidence-cannot-cross-attempts",
    version: 1,
    title: "Evidence bound to another attempt cannot complete this one",
    covers: ["plan.evidence-cannot-be-carried-across-attempts"],
    run: () => {
      // The step ran as attempt-1, was blocked, resumed, and now runs as attempt-2.
      const blocked = apply(
        seed(),
        { id: eventID(), at: at(), type: "claim", stepID: "one", attempt: attempt("attempt-1") },
        { id: eventID(), at: at(), type: "block", stepID: "one", reason: "the gate was red" },
      )
      const resumed = apply(blocked, { id: eventID(), at: at(), type: "resume", stepID: "one" })
      const second = apply(
        resumed,
        { id: eventID(), at: at(), type: "claim", stepID: "one", attempt: attempt("attempt-2") },
        {
          id: eventID(),
          at: at(),
          type: "execution-finished",
          stepID: "one",
          attemptID: "attempt-2",
        },
      )
      expect(rejected(second, complete([bound("ev-1", { attemptID: "attempt-1" })])).code).toBe(
        "duplicate-evidence",
      )
      expect(transition(second, complete([bound()])).steps[0]?.state).toBe("completed")
    },
  },
  {
    id: "plan.evidence-cannot-be-reused-by-another-step",
    version: 1,
    title: "One evidence id cannot certify two steps",
    covers: ["plan.evidence-cannot-be-reused-by-another-step"],
    run: () => {
      const first = transition(verifying(), complete([bound("ev-shared")]))
      const next = apply(
        first,
        {
          id: eventID(),
          at: at(),
          type: "claim",
          stepID: "two",
          attempt: attempt("attempt-2"),
        },
        {
          id: eventID(),
          at: at(),
          type: "execution-finished",
          stepID: "two",
          attemptID: "attempt-2",
        },
      )
      expect(rejected(next, { ...complete([bound("ev-shared")]), stepID: "two" }).code).toBe(
        "duplicate-evidence",
      )
      expect(
        transition(next, { ...complete([bound("ev-second")]), stepID: "two" }).steps[1]?.state,
      ).toBe("completed")
    },
  },
  {
    id: "plan.completion-stamps-the-current-attempt",
    version: 1,
    title: "Evidence accepted at completion is stamped with the attempt that produced it",
    covers: ["plan.completion-stamps-the-current-attempt"],
    run: () => {
      const completed = transition(verifying("attempt-7"), complete([bound()]))
      expect(completed.steps[0]?.evidence[0]?.attemptID).toBe("attempt-7")
    },
  },
  {
    id: "plan.transitions-leave-the-legal-graph",
    version: 1,
    title: "A step cannot skip ahead in its state machine",
    covers: ["plan.steps-cannot-leave-the-legal-transition-graph"],
    run: () => {
      const pending = seed()
      expect(rejected(pending, complete([bound()])).code).toBe("illegal-transition")
      expect(
        rejected(pending, { id: eventID(), at: at(), type: "resume", stepID: "one" }).code,
      ).toBe("illegal-transition")
      expect(
        rejected(pending, {
          id: eventID(),
          at: at(),
          type: "claim",
          stepID: "nope",
          attempt: attempt("a"),
        }).code,
      ).toBe("unknown-step")
    },
  },
  {
    id: "plan.dependencies-gate-claiming",
    version: 1,
    title: "A dependent step cannot be claimed before its dependency completes",
    covers: ["plan.dependencies-gate-claiming"],
    run: () => {
      const plan = seed()
      expect(
        rejected(plan, {
          id: eventID(),
          at: at(),
          type: "claim",
          stepID: "two",
          attempt: attempt("attempt-2"),
        }).code,
      ).toBe("dependencies-incomplete")
      const done = transition(verifying(), complete([bound()]))
      expect(
        apply(done, {
          id: eventID(),
          at: at(),
          type: "claim",
          stepID: "two",
          attempt: attempt("attempt-2"),
        }).steps[1]?.state,
      ).toBe("running")
    },
  },
  {
    id: "plan.attempt-owns-a-step-once",
    version: 1,
    title: "The same attempt id cannot claim two steps",
    covers: ["plan.one-attempt-cannot-own-a-step-twice"],
    run: () => {
      const done = transition(verifying("attempt-1"), complete([bound()]))
      expect(
        rejected(done, {
          id: eventID(),
          at: at(),
          type: "claim",
          stepID: "two",
          attempt: attempt("attempt-1"),
        }).code,
      ).toBe("duplicate-attempt")
    },
  },
  {
    id: "plan.foreign-parents-cannot-claim",
    version: 1,
    title: "A step cannot be claimed by a session that does not own the plan",
    covers: ["plan.foreign-parents-cannot-claim-our-steps"],
    run: () => {
      expect(
        rejected(seed(), {
          id: eventID(),
          at: at(),
          type: "claim",
          stepID: "one",
          attempt: attempt("attempt-x", "someone-else"),
        }).code,
      ).toBe("foreign-parent")
    },
  },
  {
    id: "plan.graph-rejects-cycles-and-duplicates",
    version: 1,
    title: "A plan with a dependency cycle or duplicate step ids is refused at creation",
    covers: ["plan.dependencies-gate-claiming"],
    run: () => {
      expect(() =>
        createPlan({
          id: "cyclic",
          projectID: "proj",
          parentSessionID: "parent",
          at: AT,
          steps: [
            { id: "a", objective: "A", dependencies: ["b"] },
            { id: "b", objective: "B", dependencies: ["a"] },
          ],
        }),
      ).toThrow(PlanError)
      expect(() =>
        createPlan({
          id: "dupe",
          projectID: "proj",
          parentSessionID: "parent",
          at: AT,
          steps: [
            { id: "a", objective: "A", dependencies: [] },
            { id: "a", objective: "A again", dependencies: [] },
          ],
        }),
      ).toThrow(PlanError)
    },
  },
  {
    id: "journal.unresolved-blocks-readmission",
    version: 1,
    title: "A crash between intent and admission is never readmitted",
    covers: ["journal.unresolved-attempts-block-readmission"],
    run: () => {
      const journal = openRunJournal(":memory:")
      try {
        const request = {
          projectID: "proj",
          parentSessionID: "parent",
          taskID: "task-1",
          route: { kind: "agent" as const, id: "OMO_worker" },
          prompt: "work",
          skills: [],
          background: true,
        }
        const resolved = { agentID: "OMO_worker", skills: [], prompt: "work", background: true }
        journal.intent("attempt-a", request, resolved)
        expect(journal.unresolved().map((item) => item.phase)).toEqual(["intent"])
        expect(journal.retrySafe("parent", "task-1")).toBe(false)
        expect(() => journal.intent("attempt-b", request, resolved)).toThrow(
          "unreconciled-attempt: task-1",
        )
        // Another session's task is unaffected by our unresolved intent.
        expect(journal.retrySafe("parent", "task-2")).toBe(true)
      } finally {
        journal.close()
      }
    },
  },
  {
    id: "journal.terminal-clears-unresolved",
    version: 1,
    title: "A terminal outcome makes the task retry-safe again",
    covers: ["journal.terminal-outcome-clears-unresolved-state"],
    run: () => {
      const journal = openRunJournal(":memory:")
      try {
        const request = {
          projectID: "proj",
          parentSessionID: "parent",
          taskID: "task-1",
          route: { kind: "agent" as const, id: "OMO_worker" },
          prompt: "work",
          skills: [],
          background: true,
        }
        const resolved = { agentID: "OMO_worker", skills: [], prompt: "work", background: true }
        journal.intent("attempt-a", request, resolved)
        journal.prepared("attempt-a", "child-1")
        expect(journal.unresolved()).toHaveLength(1)
        journal.terminal("attempt-a", "completed")
        expect(journal.unresolved()).toEqual([])
        expect(journal.retrySafe("parent", "task-1")).toBe(true)
        expect(() => journal.intent("attempt-b", request, resolved)).not.toThrow()
      } finally {
        journal.close()
      }
    },
  },
  {
    id: "journal.blocked-runs-are-unresolved",
    version: 1,
    title: "A blocked run is unresolved and keeps its recorded error",
    covers: ["journal.unresolved-attempts-block-readmission"],
    run: () => {
      const journal = openRunJournal(":memory:")
      try {
        journal.intent(
          "attempt-a",
          {
            projectID: "proj",
            parentSessionID: "parent",
            taskID: "task-1",
            route: { kind: "agent", id: "OMO_worker" },
            prompt: "work",
            skills: [],
            background: true,
          },
          { agentID: "OMO_worker", skills: [], prompt: "work", background: true },
        )
        const blocked = journal.block("attempt-a", "the gate was red")
        expect(blocked.phase).toBe("blocked")
        expect(blocked.error).toBe("the gate was red")
        expect(journal.unresolved().map((item) => item.phase)).toEqual(["blocked"])
        expect(journal.retrySafe("parent", "task-1")).toBe(false)
      } finally {
        journal.close()
      }
    },
  },
  {
    id: "panel.malformed-never-reads-as-clear",
    version: 1,
    title: "A status payload the panel cannot read is never reported as nothing blocked",
    covers: ["panel.malformed-input-never-reads-as-clear"],
    run: () => {
      for (const payload of [
        undefined,
        null,
        "not-an-object",
        {},
        { runs: "nope", plans: [] },
        { runs: [], plans: [{ parentSessionID: "parent" }] },
        { runs: [{ phase: "blocked" }], plans: [] },
      ]) {
        const panel = buildBlockedPanel(payload, panelOptions)
        expect(panel.status).not.toBe("clear")
        expect(panel.unreadable.length + panel.blockedRuns.length).toBeGreaterThan(0)
      }
      const blockedWithoutIdentity = buildBlockedPanel(
        { runs: [{ phase: "blocked", taskID: "t", sessionID: "s" }], plans: [] },
        panelOptions,
      )
      expect(blockedWithoutIdentity.status).toBe("blocked")
      expect(blockedWithoutIdentity.blockedRuns[0]?.attemptID).toBeNull()
    },
  },
  {
    id: "panel.blocked-runs-surface-their-reason",
    version: 1,
    title: "A blocked run is listed with the reason it actually recorded",
    covers: ["panel.blocked-runs-surface-their-recorded-reason"],
    run: () => {
      const panel = buildBlockedPanel(
        {
          runs: [
            {
              attemptID: "attempt-b",
              taskID: "task-b",
              sessionID: "child-b",
              phase: "blocked",
              error: "the gate was red",
              updatedAt: AT - 1000,
            },
            {
              attemptID: "attempt-a",
              taskID: "task-a",
              sessionID: "child-a",
              phase: "blocked",
              updatedAt: AT - 5000,
            },
          ],
          plans: [],
        },
        panelOptions,
      )
      expect(panel.status).toBe("blocked")
      // Oldest first: a blocked run that has waited longest leads.
      expect(panel.blockedRuns.map((item) => item.attemptID)).toEqual(["attempt-a", "attempt-b"])
      expect(panel.blockedRuns[1]?.reason).toBe("the gate was red")
      expect(panel.blockedRuns[0]?.reason).toBeNull()
      expect(panel.blockedRuns[0]?.ageMs).toBe(5000)
    },
  },
  {
    id: "panel.in-flight-is-not-blocked",
    version: 1,
    title: "A run that is still in flight is counted as unresolved, never as blocked",
    covers: ["panel.in-flight-phases-are-not-reported-as-blocked"],
    run: () => {
      const panel = buildBlockedPanel(
        {
          runs: [
            { attemptID: "a", taskID: "t", sessionID: "s", phase: "admitted", updatedAt: AT },
            { attemptID: "b", taskID: "t2", sessionID: "s", phase: "prepared", updatedAt: AT },
            { attemptID: "c", taskID: "t3", sessionID: "s", phase: "completed", updatedAt: AT },
          ],
          plans: [],
        },
        panelOptions,
      )
      expect(panel.blockedRuns).toEqual([])
      expect(panel.unresolved).toMatchObject({ admitted: 1, prepared: 1, intent: 0, blocked: 0 })
      expect(panel.status).toBe("clear")
    },
  },
  {
    id: "doctor.absent-git-blocks-only-git-features",
    version: 1,
    title: "A missing git binary degrades the report and names the features it blocks",
    covers: ["doctor.absent-git-blocks-only-git-dependent-features"],
    run: async () => {
      const report = await diagnose({
        ...healthyInputs(),
        probeGit: async () => ({ available: false, reason: "git is not installed" }),
      })
      const git = report.checks.find((item) => item.id === "git")
      expect(git?.status).toBe("fail")
      expect(git?.required).toBe(false)
      expect(report.blockedFeatures).toEqual(["worktrees", "memory-commit"])
      expect(report.independentFeatures).toContain("delegation")
      expect(report.independentFeatures).toContain("plans")
      expect(report.status).toBe("degraded")
    },
  },
  {
    id: "doctor.pending-asks-are-facts",
    version: 1,
    title: "Pending permission asks are reported as observed facts, not authorizations",
    covers: ["doctor.pending-asks-are-observed-facts-not-authorizations"],
    run: async () => {
      const report = await diagnose({
        ...healthyInputs(),
        listPendingPermissions: async () => [
          { id: "perm-1", action: "subagent", resources: ["read"] },
        ],
      })
      const check = report.checks.find((item) => item.id === "permissions")
      expect(check?.observed).toMatchObject({ count: 1 })
      // A pending ask is an open question, never a decision: no effect is claimed.
      expect(JSON.stringify(report)).not.toContain("allow")
      expect(JSON.stringify(report)).not.toContain("deny")
      expect(check?.note).toContain("does not imply")
    },
  },
  {
    id: "doctor.unverifiable-never-reads-as-all-clear",
    version: 1,
    title: "An observation that cannot be made leaves the report degraded",
    covers: ["doctor.unverifiable-observations-never-read-as-all-clear"],
    run: async () => {
      const report = await diagnose({
        ...healthyInputs(),
        readSdkVersion: async () => {
          throw new Error("the host surface could not be read")
        },
      })
      const sdk = report.checks.find((item) => item.id === "sdk-version")
      expect(sdk?.status).toBe("unknown")
      expect(report.status).toBe("degraded")
      expect(report.status).not.toBe("ok")
      expect(
        report.checks.some((item) => item.status === "unknown" && item.required === true),
      ).toBe(true)
    },
  },
  {
    id: "doctor.abort-yields-cancelled",
    version: 1,
    title: "An aborted diagnosis reports cancelled and observes nothing",
    covers: ["doctor.unverifiable-observations-never-read-as-all-clear"],
    run: async () => {
      let probes = 0
      const report = await diagnose({
        ...healthyInputs(),
        probeGit: async () => {
          probes++
          return { available: true, version: "git version 2.55.0" }
        },
        signal: AbortSignal.abort(),
      })
      expect(report.status).toBe("cancelled")
      expect(report.checks).toEqual([])
      expect(probes).toBe(0)
    },
  },
  {
    id: "doctor.empty-model-catalogue-fails",
    version: 1,
    title: "A host that exposes no models is diagnosed as a failure, not a pass",
    covers: ["doctor.unverifiable-observations-never-read-as-all-clear"],
    run: async () => {
      const report = await diagnose({ ...healthyInputs(), listModels: async () => [] })
      const models = report.checks.find((item) => item.id === "models")
      expect(models?.status).toBe("fail")
      expect(models?.required).toBe(false)
      // A user with no provider authenticated is not an incompatible host, so
      // the report degrades rather than declaring the environment unusable.
      expect(report.status).toBe("degraded")
      expect(models?.remediation).toContain("delegation cannot resolve a model")
    },
  },
  {
    id: "revision.a-claim-needs-a-probe",
    version: 1,
    title: "A stored revision reads as asserted until a probe observes it",
    covers: ["revision.a-declared-revision-is-asserted-until-a-probe-confirms-it"],
    run: async () => {
      const withoutProbe = await buildRevisionLinkage(linked())
      expect(withoutProbe.status).toBe("asserted")
      // Omitting a probe cannot confirm anything, and the report says so out loud.
      expect(withoutProbe.items[0]?.corroborations).toEqual([
        {
          kind: "revision",
          target: REVISION,
          verdict: "unverifiable",
          detail: "no corroboration probe was supplied",
        },
      ])
      expect(withoutProbe.notes.join(" ")).toContain("caller-stated claim")

      const confirmed = await buildRevisionLinkage(linked(), {
        resolveRevision: async () => "present",
      })
      expect(confirmed.status).toBe("linked")
      expect(confirmed.revisions).toEqual([REVISION])
    },
  },
  {
    id: "revision.divergent-claims-never-link",
    version: 1,
    title: "Two steps claiming different revisions cannot read as linked",
    covers: ["revision.divergent-revisions-never-read-as-linked"],
    run: async () => {
      const first = transition(verifying(), complete([bound("ev-1", { revision: REVISION })]))
      const next = apply(
        first,
        { id: eventID(), at: at(), type: "claim", stepID: "two", attempt: attempt("attempt-2") },
        {
          id: eventID(),
          at: at(),
          type: "execution-finished",
          stepID: "two",
          attemptID: "attempt-2",
        },
      )
      const divergent = transition(next, {
        ...complete([bound("ev-2", { revision: `${REVISION}9` })]),
        stepID: "two",
      })
      const linkage = await buildRevisionLinkage(divergent, {
        resolveRevision: async () => "present",
      })
      // Both revisions were confirmed, and the plan is still not linked to one of them.
      expect(linkage.revisions).toEqual([REVISION, `${REVISION}9`].sort())
      expect(linkage.status).toBe("divergent")
      expect(
        linkage.items.every((item) =>
          item.corroborations.every((entry) => entry.verdict === "confirmed"),
        ),
      ).toBe(true)
    },
  },
  {
    id: "revision.probe-failure-is-unverifiable",
    version: 1,
    title: "A probe that cannot answer never refutes a claim",
    covers: ["revision.probe-failure-is-unverifiable-never-contradicted"],
    run: async () => {
      const linkage = await buildRevisionLinkage(linked(), {
        resolveRevision: async () => {
          throw new Error("git is not installed")
        },
      })
      expect(linkage.status).toBe("asserted")
      expect(linkage.items[0]?.corroborations[0]).toEqual({
        kind: "revision",
        target: REVISION,
        verdict: "unverifiable",
        detail: "the probe failed: git is not installed",
      })
    },
  },
  {
    id: "revision.a-waiver-is-not-evidence",
    version: 1,
    title: "A waived step is listed and never counted as revision-linked",
    covers: ["revision.a-waived-step-is-never-revision-linked"],
    run: async () => {
      const plan = transition(verifying(), complete([], "documentation only"))
      const linkage = await buildRevisionLinkage(plan, { resolveRevision: async () => "present" })
      expect(linkage.items).toEqual([])
      expect(linkage.waivers).toEqual([{ stepID: "one", waiver: "documentation only" }])
      expect(linkage.status).toBe("unlinked")
      expect(linkage.notes.join(" ")).toContain("a waived step is not evidence")
    },
  },
]

/** Diagnose inputs describing a healthy host; individual scenarios degrade one probe. */
const healthyInputs = () => ({
  app: { name: "cli", version: "2.0.24", channel: "latest" },
  readSdkVersion: async () => "2.0.24",
  readRuntimeVersion: async () => "bun 1.4.2",
  observeCapabilities: () => [
    "session.create",
    "session.prompt",
    "session.hook",
    "session.synthetic",
    "session.context",
    "tool.transform",
    "tool.hook",
    "command.transform",
    "permission.list",
  ],
  listModels: async () => [{ providerID: "opencode", modelID: "space-bunny-free" }],
  probeGit: async () => ({ available: true, version: "git version 2.55.0" }),
  probeOptional: async (service: "lsp" | "tmux") =>
    service === "lsp"
      ? { available: true, detail: "typescript-language-server configured" }
      : { available: false, reason: "tmux is not installed" },
  listPendingPermissions: async () => [],
  requiredSdk: "2.0.24",
  requiredHost: "2.0.24",
  now: () => AT,
})
