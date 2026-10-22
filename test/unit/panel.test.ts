import { describe, expect, test } from "bun:test"
import { buildBlockedPanel } from "../../src/diagnostics/panel"

const NOW = 1_800_000_000_000

const run = (over: Record<string, unknown> = {}) => ({
  attemptID: "attempt-1",
  taskID: "task-1",
  agentID: "executor",
  phase: "blocked",
  error: "admission-timeout",
  updatedAt: NOW - 1_000,
  startedAt: NOW - 5_000,
  finishedAt: undefined,
  sessionID: "ses_child",
  depth: 1,
  maxDepth: 2,
  skills: [],
  skillReasons: [],
  ...over,
})

const step = (over: Record<string, unknown> = {}) => ({
  id: "step-1",
  objective: "Reconcile the blocked attempt",
  dependencies: [],
  state: "blocked",
  attempts: [{ attemptID: "attempt-1", state: "blocked", startedAt: NOW - 5_000 }],
  evidence: [],
  reason: "delegate-reported-failure",
  ...over,
})

const plan = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: "plan-1",
  projectID: "proj",
  parentSessionID: "parent",
  revision: 2,
  createdAt: NOW - 60_000,
  updatedAt: NOW - 2_000,
  steps: [step()],
  appliedEvents: [],
  ...over,
})

const status = (over: Record<string, unknown> = {}) => ({
  plans: [plan()],
  runs: [run()],
  scheduler: { active: 1, queued: 0 },
  diagnostics: {},
  ...over,
})

const panel = (payload: unknown, parentSessionID = "parent") =>
  buildBlockedPanel(payload, { parentSessionID, now: NOW })

describe("blocked runs panel", () => {
  test("reports a blocked run with the recorded reason verbatim", () => {
    const result = panel(status())
    expect(result.status).toBe("blocked")
    expect(result.blockedRuns).toHaveLength(1)
    expect(result.blockedRuns[0]).toMatchObject({
      attemptID: "attempt-1",
      taskID: "task-1",
      sessionID: "ses_child",
      phase: "blocked",
      reason: "admission-timeout",
      ageMs: 1_000,
    })
  })

  test("a blocked run without a recorded reason reports null instead of a guess", () => {
    const result = panel(status({ runs: [run({ error: undefined })] }))
    expect(result.blockedRuns[0]?.reason).toBeNull()
    expect(result.notes.join(" ")).toContain("an absent recorded reason is not an absence of cause")
  })

  test("reports blocked plan steps with their verbatim step reason", () => {
    const result = panel(
      status({
        plans: [
          plan({
            steps: [
              step({ id: "step-b", reason: "second-block" }),
              step({ id: "step-a", reason: "first-block" }),
            ],
          }),
        ],
        runs: [],
      }),
    )
    expect(result.blockedSteps.map((entry) => entry.stepID)).toEqual(["step-a", "step-b"])
    expect(result.blockedSteps[0]).toMatchObject({
      planID: "plan-1",
      objective: "Reconcile the blocked attempt",
      reason: "first-block",
      lastAttemptID: "attempt-1",
    })
  })

  test("clear requires both an absence of blocked state and fully readable sections", () => {
    const result = panel(
      status({
        plans: [plan({ steps: [step({ state: "completed", reason: undefined })] })],
        runs: [run({ phase: "completed", error: undefined })],
      }),
    )
    expect(result.status).toBe("clear")
    expect(result.blockedRuns).toEqual([])
    expect(result.blockedSteps).toEqual([])
    expect(result.unreadable).toEqual([])
  })

  test("in-flight phases are counted but never reported as blocked", () => {
    const result = panel(
      status({
        runs: [
          run({ attemptID: "a", phase: "intent" }),
          run({ attemptID: "b", phase: "prepared" }),
          run({ attemptID: "c", phase: "admitted" }),
          run({ attemptID: "d", phase: "blocked" }),
        ],
      }),
    )
    expect(result.unresolved).toEqual({ intent: 1, prepared: 1, admitted: 1, blocked: 1 })
    expect(result.blockedRuns.map((entry) => entry.attemptID)).toEqual(["d"])
  })

  test("a malformed run entry makes the panel unknown instead of clear", () => {
    const result = panel(status({ runs: [{ taskID: "task-1" }, run()] }))
    expect(result.status).toBe("blocked")
    expect(result.unreadable).toContain("runs[0]: phase is not a string")
  })

  test("a missing runs section makes the panel unknown instead of clear", () => {
    const result = panel(status({ runs: undefined }))
    expect(result.status).not.toBe("clear")
    expect(result.unreadable).toContain("runs: expected an array")
  })

  test("a payload that is not an object is unknown, never clear", () => {
    const result = panel("no status payload")
    expect(result.status).toBe("unknown")
    expect(result.unreadable).toEqual(["status: expected an object"])
    expect(result.blockedRuns).toEqual([])
  })

  test("a blocked step outranks unreadable sections but never hides them", () => {
    const result = panel(status({ runs: undefined }))
    expect(result.status).toBe("blocked")
    expect(result.unreadable).toContain("runs: expected an array")
  })

  test("plans owned by another parent are observed and counted, not shown", () => {
    const result = panel(
      status({
        plans: [plan({ id: "plan-foreign", parentSessionID: "other" })],
        runs: [],
      }),
    )
    expect(result.foreignPlans).toBe(1)
    expect(result.blockedSteps).toEqual([])
    expect(result.notes.join(" ")).toContain("1 plan owned by another session")
  })

  test("a plan with an unverifiable owner is unreadable, never clear", () => {
    const result = panel(status({ plans: [{ ...plan(), parentSessionID: undefined }], runs: [] }))
    expect(result.status).not.toBe("clear")
    expect(result.unreadable).toContain("plans[0].parentSessionID: expected a string")
  })

  test("blocked runs are ordered oldest first and ties break on attempt id", () => {
    const result = panel(
      status({
        runs: [
          run({ attemptID: "z", updatedAt: NOW - 10 }),
          run({ attemptID: "b", updatedAt: NOW - 100 }),
          run({ attemptID: "a", updatedAt: NOW - 100 }),
        ],
      }),
    )
    expect(result.blockedRuns.map((entry) => entry.attemptID)).toEqual(["a", "b", "z"])
  })

  test("age is clamped at zero and null when the timestamp is not a finite number", () => {
    const result = panel(
      status({
        runs: [
          run({ attemptID: "future", updatedAt: NOW + 5_000 }),
          run({ attemptID: "unrecorded", updatedAt: "soon" }),
        ],
      }),
    )
    expect(result.blockedRuns.find((entry) => entry.attemptID === "future")?.ageMs).toBe(0)
    expect(result.blockedRuns.find((entry) => entry.attemptID === "unrecorded")?.ageMs).toBeNull()
    expect(
      result.blockedRuns.find((entry) => entry.attemptID === "unrecorded")?.updatedAt,
    ).toBeNull()
  })

  test("reads the injected clock and never the host clock", () => {
    const result = panel(status())
    expect(result.generatedAt).toBe(NOW)
    expect(result.parentSessionID).toBe("parent")
  })

  test("declares that run scoping is pre-filtered and cannot be re-verified", () => {
    const result = panel(status())
    expect(result.notes.join(" ")).toContain(
      "run entries arrive pre-filtered to the requested parent by the runtime status source",
    )
  })

  test("publishes observations only, with no remediation or retry advice", () => {
    const result = panel(status())
    expect(Object.keys(result).sort()).toEqual([
      "blockedRuns",
      "blockedSteps",
      "foreignPlans",
      "generatedAt",
      "notes",
      "parentSessionID",
      "schemaVersion",
      "status",
      "unreadable",
      "unresolved",
    ])
    expect(Object.keys(result.blockedRuns[0] ?? {}).sort()).toEqual([
      "ageMs",
      "attemptID",
      "phase",
      "reason",
      "sessionID",
      "taskID",
      "updatedAt",
    ])
    expect(Object.keys(result.blockedSteps[0] ?? {}).sort()).toEqual([
      "lastAttemptID",
      "objective",
      "planID",
      "planUpdatedAt",
      "reason",
      "stepID",
    ])
  })

  test("pins the panel schema version", () => {
    expect(panel(status()).schemaVersion).toBe(1)
  })
})
