import { expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecutionAdapter } from "../../src/contracts"
import { createPlan } from "../../src/plans/model"
import { transition } from "../../src/plans/transitions"
import { reconcileAndSave, reconcilePlan } from "../../src/state/reconcile"
import { openPlanRepository } from "../../src/state/repository"

const base = () =>
  createPlan({
    id: "plan",
    projectID: "project",
    parentSessionID: "parent",
    at: 100,
    steps: [
      { id: "build", objective: "Build", dependencies: [] },
      { id: "review", objective: "Review", dependencies: ["build"] },
    ],
  })
const active = () =>
  transition(base(), {
    id: "claim",
    at: 101,
    type: "claim",
    stepID: "build",
    attempt: {
      attemptID: "attempt",
      sessionID: "child",
      parentSessionID: "parent",
      agentID: "executor",
    },
  })
function adapter(state: "running" | "completed" | "failed" | "cancelled" | "unknown") {
  return {
    inspect: mock(async (_sessionID: string) => ({ state })),
    launch: mock(async () => {
      throw new Error("Recovery must not admit work")
    }),
    cancel: mock(async (_sessionID: string) => {}),
  } satisfies ExecutionAdapter
}

test("missing terminal event yields verification work without admitting another child", async () => {
  const host = adapter("completed")
  expect(await reconcilePlan(active(), host)).toEqual([
    { kind: "complete", stepID: "build", attemptID: "attempt", sessionID: "child" },
  ])
  expect(host.inspect.mock.calls).toEqual([["child"]])
  expect(host.launch).not.toHaveBeenCalled()
  expect(host.cancel).not.toHaveBeenCalled()
})

test("unknown admission stays blocked; active children remain observed after owner restart", async () => {
  for (const [state, kind] of [
    ["unknown", "block"],
    ["running", "observe"],
    ["failed", "fail"],
    ["cancelled", "fail"],
  ] as const) {
    const host = adapter(state)
    const decisions = await reconcilePlan(active(), host)
    expect(decisions[0]?.kind).toBe(kind)
    expect(decisions[0]?.sessionID).toBe("child")
    expect(host.launch).not.toHaveBeenCalled()
  }
})

test("completed child awaiting evidence does not complete its step or unlock dependents", async () => {
  const verifying = transition(active(), {
    id: "finished",
    at: 102,
    type: "execution-finished",
    stepID: "build",
    attemptID: "attempt",
  })
  expect((await reconcilePlan(verifying, adapter("completed")))[0]?.kind).toBe("observe")
  const completed = transition(verifying, {
    id: "verified",
    at: 103,
    type: "complete",
    stepID: "build",
    evidence: [
      {
        id: "test",
        description: "Tests passed",
        command: "bun test test/integration",
        exitCode: 0,
        revision: "abc123",
        origin: "auto",
      },
    ],
  })
  expect(await reconcilePlan(completed, adapter("completed"))).toEqual([
    { kind: "ready", stepID: "review" },
  ])
})

test("parent cancellation remains final and still observes active native children", async () => {
  const cancelled = transition(active(), { id: "cancel-parent", at: 102, type: "cancel-parent" })
  const host = adapter("running")
  expect((await reconcilePlan(cancelled, host))[0]).toMatchObject({
    kind: "observe",
    sessionID: "child",
  })
  expect(host.launch).not.toHaveBeenCalled()
  expect(await reconcilePlan(cancelled, adapter("completed"))).toEqual([])
  const verifying = transition(active(), {
    id: "finished",
    at: 102,
    type: "execution-finished",
    stepID: "build",
    attemptID: "attempt",
  })
  const completed = transition(verifying, {
    id: "verified",
    at: 103,
    type: "complete",
    stepID: "build",
    evidence: [
      {
        id: "check",
        description: "Verified",
        command: "bun test test/integration",
        exitCode: 0,
        revision: "abc123",
        origin: "auto",
      },
    ],
  })
  const cancelledAfterCompletion = transition(completed, {
    id: "cancel-later",
    at: 104,
    type: "cancel-parent",
  })
  const unavailable = adapter("unknown")
  expect(await reconcilePlan(cancelledAfterCompletion, unavailable)).toEqual([])
  expect(unavailable.inspect).not.toHaveBeenCalled()
})

test("recovery persists verification before returning and is idempotent after reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omo recovery "))
  const path = join(directory, "state.sqlite")
  const scope = { projectID: "project", locationID: "location", parentSessionID: "parent" }
  const repository = openPlanRepository(path)
  try {
    await repository.save(scope, base(), null)
    await repository.save(scope, active(), 0)
    const first = await reconcileAndSave(scope, "plan", repository, adapter("completed"), 102)
    expect(first.plan.steps[0]?.state).toBe("verifying")
    expect(first.plan.steps[1]?.state).toBe("pending")
    repository.close()
    const reopened = openPlanRepository(path)
    try {
      const second = await reconcileAndSave(scope, "plan", reopened, adapter("completed"), 103)
      expect(second.plan).toEqual(first.plan)
      expect(second.decisions.every((decision) => decision.kind !== "ready")).toBe(true)
      expect(await reopened.load(scope, "plan")).toEqual(first.plan)
    } finally {
      reopened.close()
    }
  } finally {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("recovery never overwrites a cancellation committed while inspecting the child", async () => {
  const scope = { projectID: "project", locationID: "location", parentSessionID: "parent" }
  const repository = openPlanRepository(":memory:")
  try {
    await repository.save(scope, base(), null)
    await repository.save(scope, active(), 0)
    const cancelled = transition(active(), {
      id: "concurrent-cancel",
      at: 102,
      type: "cancel-parent",
    })
    const host = adapter("completed")
    host.inspect.mockImplementation(async (_sessionID: string) => {
      await repository.save(scope, cancelled, 1)
      return { state: "completed" }
    })
    await expect(reconcileAndSave(scope, "plan", repository, host, 103)).rejects.toMatchObject({
      code: "revision-conflict",
    })
    expect(await repository.load(scope, "plan")).toEqual(cancelled)
    expect(host.launch).not.toHaveBeenCalled()
  } finally {
    repository.close()
  }
})
