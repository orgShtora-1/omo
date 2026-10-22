import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type GoalLimits,
  type GoalStore,
  openGoalStore,
  type UsageSnapshot,
} from "../../src/goal/store"

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-limits-"))
  const store = openGoalStore(dir)
  return { dir, store, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const session = "ses_owner"

function snapshot(cost: number, total: number): UsageSnapshot {
  return {
    cost,
    tokens: { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

test.each([
  ["zero", { maxCost: 0 }],
  ["negative", { maxCost: -1 }],
  ["non-finite", { maxCost: Number.POSITIVE_INFINITY }],
  ["fractional tokens", { maxTokens: 1.5 }],
  ["non-numeric", { maxCost: "1" }],
  ["empty", {}],
  ["unknown dimension", { maxDuration: 60 }],
])("goal limits refuse %s without writing a goal", async (_name, limits: unknown) => {
  const { dir, store, cleanup } = await tempStore()
  try {
    expect(() => store.set(session, "objective", limits as GoalLimits | undefined)).toThrow(
      "invalid-limits",
    )
    expect(store.get(session)).toBeNull()
    expect(await readFile(join(dir, `${session}.json`)).catch(() => null)).toBeNull()
  } finally {
    await cleanup()
  }
})

test("crossing the cost limit pauses the goal and records the dimension", async () => {
  const { store, cleanup } = await tempStore()
  try {
    store.set(session, "ship release", { maxCost: 0.1 })
    // Host reports are cumulative, so the first one only becomes the baseline.
    expect(store.accrueSnapshot(session, snapshot(0.05, 10))?.status).toBe("active")
    const crossed = store.accrueSnapshot(session, snapshot(0.16, 20))
    expect(crossed?.status).toBe("paused")
    expect(crossed?.limitExceeded).toBe("cost")
    expect(crossed?.costUsed).toBeCloseTo(0.11, 10)
    // A paused goal keeps accounting but never resumes itself.
    expect(store.accrueSnapshot(session, snapshot(0.2, 200))?.status).toBe("paused")
    expect(store.accrueSnapshot(session, snapshot(0.2, 200))?.limitExceeded).toBe("cost")
  } finally {
    await cleanup()
  }
})

test("crossing both budgets reports cost before tokens, and tokens alone reports tokens", async () => {
  const both = await tempStore()
  const tokensOnly = await tempStore()
  try {
    both.store.set(session, "ship release", { maxTokens: 100, maxCost: 5 })
    both.store.accrueSnapshot(session, snapshot(0, 10))
    const crossed = both.store.accrueSnapshot(session, snapshot(6, 150))
    expect(crossed?.limitExceeded).toBe("cost")
    expect(crossed?.status).toBe("paused")
    tokensOnly.store.set(session, "ship release", { maxTokens: 100 })
    tokensOnly.store.accrueSnapshot(session, snapshot(0, 10))
    const tokenLimit = tokensOnly.store.accrueSnapshot(session, snapshot(1, 150))
    expect(tokenLimit?.limitExceeded).toBe("tokens")
    expect(tokenLimit?.status).toBe("paused")
  } finally {
    await both.cleanup()
    await tokensOnly.cleanup()
  }
})

test("resume stays refused while a limit is exceeded and only clear escapes the breach", async () => {
  const { store, cleanup } = await tempStore()
  try {
    store.set(session, "ship release", { maxCost: 0.1 })
    store.accrueSnapshot(session, snapshot(0.05, 10))
    store.accrueSnapshot(session, snapshot(0.16, 20))
    expect(() => store.resume(session)).toThrow("limit-exceeded: cost")
    expect(store.get(session)?.status).toBe("paused")
    // Raising the budget through the model would silently re-arm a breached goal,
    // so a rewrite is refused and lifetime usage is preserved until `clear`.
    expect(() => store.set(session, "ship release with a larger budget", { maxCost: 10 })).toThrow(
      "limit-exceeded: cost",
    )
    const breached = store.get(session)
    expect(breached?.limits).toEqual({ maxCost: 0.1 })
    expect(breached?.costUsed).toBeGreaterThan(0)
    expect(store.clear(session)).toBe(true)
    expect(store.set(session, "ship release with a larger budget", { maxCost: 10 })?.status).toBe(
      "active",
    )
  } finally {
    await cleanup()
  }
})

test("cancelled goals are terminal and only clear removes them", async () => {
  const { store, cleanup } = await tempStore()
  try {
    store.set(session, "ship release", { maxCost: 1 })
    expect(store.cancel(session)?.status).toBe("cancelled")
    for (const mutate of [
      () => store.resume(session),
      () => store.complete(session),
      () => store.pause(session),
    ]) {
      expect(mutate).toThrow("cancelled goal is terminal")
    }
    expect(store.cancel(session)?.status).toBe("cancelled")
    expect(store.accrueSnapshot(session, snapshot(2, 20))?.status).toBe("cancelled")
    expect(store.get(session)?.status).toBe("cancelled")
    expect(store.clear(session)).toBe(true)
    expect(store.get(session)).toBeNull()
  } finally {
    await cleanup()
  }
})

test("resume is refused while an admission is unresolved until recovery", async () => {
  const { store, cleanup } = await tempStore()
  try {
    store.set(session, "ship release")
    const reservation = store.noteContinuation(session)
    expect(reservation?.continuationPending).toBe(true)
    expect(() => store.resume(session)).toThrow("unresolved-continuation")
    const abandoned = store.recoverContinuation(session, "abandon")
    expect(abandoned?.continuationPending).toBe(false)
    expect(abandoned?.status).toBe("paused")
    expect(abandoned?.continuations).toBe(1)
    const retried = store.recoverContinuation(session, "retry")
    expect(retried).toEqual(abandoned)
    expect(retried?.continuations).toBe(1)
    expect(store.resume(session)?.continuations).toBe(0)
  } finally {
    await cleanup()
  }
})

test("recovery requires a pending admission, preserves counters and rejects unknown dispositions", async () => {
  const { store, cleanup } = await tempStore()
  try {
    store.set(session, "ship release")
    expect(store.recoverContinuation(session, "abandon")?.continuationPending).toBe(false)
    expect(store.recoverContinuation(session, "retry")?.status).toBe("active")
    expect(() => store.recoverContinuation(session, "sideways" as "retry")).toThrow(
      "invalid-recovery-disposition",
    )
    expect(store.get(session)?.status).toBe("active")
    store.noteContinuation(session)
    const recovered = store.recoverContinuation(session, "retry")
    expect(recovered?.continuationPending).toBe(false)
    expect(recovered?.status).toBe("active")
    expect(recovered?.continuations).toBe(1)
    expect(store.recoverContinuation("ses_missing", "retry")).toBeNull()
  } finally {
    await cleanup()
  }
})

test.each(["limit-value", "limit-dimension", "status"])(
  "corrupt %s in a persisted goal reads as absent",
  async (kind) => {
    const { dir, store, cleanup } = await tempStore()
    try {
      const base = store.set(session, "ship release", { maxCost: 1 })
      if (!base) throw new Error("missing goal")
      const corrupt: Record<string, unknown> = { ...base }
      if (kind === "limit-value") corrupt.limits = { maxCost: -5 }
      if (kind === "limit-dimension") corrupt.limitExceeded = "time"
      if (kind === "status") corrupt.status = "abandoned"
      const file = join(dir, `${session}.json`)
      await writeFile(file, JSON.stringify(corrupt), "utf8")
      expect(store.get(session)).toBeNull()
      expect(store.resume(session)).toBeNull()
      expect(store.cancel(session)).toBeNull()
    } finally {
      await cleanup()
    }
  },
)

test("limits survive reopening the store so a restart cannot re-arm the budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-limits-"))
  try {
    const first = openGoalStore(dir)
    first.set(session, "ship release", { maxCost: 0.1 })
    first.accrueSnapshot(session, snapshot(0.05, 10))
    first.accrueSnapshot(session, snapshot(0.16, 20))
    const reopened = openGoalStore(dir) as GoalStore
    expect(reopened.get(session)?.limits).toEqual({ maxCost: 0.1 })
    expect(reopened.get(session)?.limitExceeded).toBe("cost")
    expect(() => reopened.resume(session)).toThrow("limit-exceeded: cost")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
