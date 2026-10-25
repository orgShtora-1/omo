import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGoalContinuation } from "../../src/goal/continuation"
import { type GoalStore, openGoalStore } from "../../src/goal/store"

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-review-"))
  const store = openGoalStore(join(dir, "goals"))
  return { store, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

function dbPath(dir: string) {
  return join(dir, "goals", "goal.db")
}

/** Mirrors the host payload, whose `cache` sub-object may be absent or partial. */
function report(sessionID: string, cost: number, tokens: Record<string, unknown>) {
  return { type: "session.usage.updated", data: { sessionID, cost, tokens } }
}

test("a usage report without cache counters still accrues and can breach a budget", async () => {
  const { store, cleanup } = await fixture()
  try {
    store.set("s", "ship it", { maxTokens: 10 })
    const continuation = createGoalContinuation({ store, prompt: async () => ({}) })
    await continuation.handleEvent(report("s", 0.01, { input: 1, output: 1, reasoning: 1 }))
    expect(store.get("s")?.tokensUsed).toBe(0)
    await continuation.handleEvent(report("s", 0.5, { input: 6, output: 6, reasoning: 6 }))
    const goal = store.get("s")
    expect(goal?.tokensUsed).toBe(15)
    expect(goal?.costUsed).toBeCloseTo(0.49, 10)
    expect(goal?.status).toBe("paused")
    expect(goal?.limitExceeded).toBe("tokens")
  } finally {
    await cleanup()
  }
})

test("a partially reported cache object is ignored instead of understating usage", async () => {
  const { store, cleanup } = await fixture()
  try {
    store.set("s", "ship it")
    const continuation = createGoalContinuation({ store, prompt: async () => ({}) })
    await continuation.handleEvent(report("s", 0.1, { input: 1, output: 1, reasoning: 1 }))
    await continuation.handleEvent(
      report("s", 0.9, { input: 5, output: 5, reasoning: 5, cache: { read: 7 } }),
    )
    expect(store.get("s")?.costUsed).toBe(0)
    expect(store.get("s")?.tokensUsed).toBe(0)
  } finally {
    await cleanup()
  }
})

test("rewriting the objective refuses to re-arm a breached budget or a cancelled goal", async () => {
  const { store, cleanup } = await fixture()
  try {
    store.set("s", "first", { maxTokens: 1 })
    await store.accrueSnapshot("s", {
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
    })
    await store.accrueSnapshot("s", {
      cost: 0,
      tokens: { input: 3, output: 3, reasoning: 3, cache: { read: 0, write: 0 } },
    })
    expect(store.get("s")?.limitExceeded).toBe("tokens")
    expect(() => store.set("s", "second", { maxTokens: 1000 })).toThrow("limit-exceeded: tokens")
    expect(() => store.set("s", "second")).toThrow("limit-exceeded: tokens")
    expect(store.get("s")?.objective).toBe("first")
    expect(store.get("s")?.status).toBe("paused")
    const clean = await fixture()
    try {
      clean.store.set("c", "first")
      clean.store.cancel("c")
      expect(() => clean.store.set("c", "second")).toThrow("cancelled goal is terminal")
      expect(clean.store.get("c")?.status).toBe("cancelled")
    } finally {
      await clean.cleanup()
    }
  } finally {
    await cleanup()
  }
})

test("cancelled goals stay cancelled through recovery, failed admission and new notes", async () => {
  const { store, cleanup } = await fixture()
  try {
    store.set("s", "first")
    const reservation = store.noteContinuation("s")
    store.cancel("s")
    expect(store.recoverContinuation("s", "abandon")?.status).toBe("cancelled")
    const finished = store.finishContinuation("s", reservation?.continuationID ?? "none", true)
    expect(finished?.status).toBe("cancelled")
    expect(store.noteContinuation("s")).toBeNull()
  } finally {
    await cleanup()
  }
})

test("a legacy record cancelled with an unresolved admission cannot be reopened as paused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-legacy-"))
  const store = openGoalStore(join(dir, "goals"))
  try {
    store.set("legacy", "first")
    const db = new Database(dbPath(dir))
    db.run(
      "UPDATE omo_goals SET status = 'cancelled', continuation_pending = 1, continuation_id = 'admission-1', active_since = NULL WHERE session_id = ?",
      ["legacy"],
    )
    db.close()
    // A record written before cancellation cleared pending work must stay terminal.
    const abandoned = store.recoverContinuation("legacy", "abandon")
    expect(abandoned?.status).toBe("cancelled")
    expect(store.finishContinuation("legacy", "admission-1", true)?.status).toBe("cancelled")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a second continuation cannot overwrite an unresolved admission", async () => {
  const { store, cleanup } = await fixture()
  try {
    store.set("s", "first")
    const first = store.noteContinuation("s")
    expect(() => store.noteContinuation("s")).toThrow("unresolved-continuation")
    expect(store.get("s")?.continuations).toBe(1)
    expect(store.get("s")?.continuationID).toBe(first?.continuationID)
  } finally {
    await cleanup()
  }
})

test("continuations are not counted for goals that are not active", async () => {
  const { store, cleanup } = await fixture()
  try {
    store.set("s", "first")
    store.pause("s")
    expect(store.noteContinuation("s")).toBeNull()
    expect(store.get("s")?.continuations).toBe(0)
    store.complete("s")
    expect(store.noteContinuation("s")).toBeNull()
    expect(store.get("s")?.continuations).toBe(0)
  } finally {
    await cleanup()
  }
})

test("a new objective keeps the cumulative baseline so usage is never silently dropped", async () => {
  const { store, cleanup } = await fixture()
  try {
    store.set("s", "first", { maxTokens: 100 })
    await store.accrueSnapshot("s", {
      cost: 0.01,
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
    })
    const replaced = store.set("s", "second", { maxTokens: 100 })
    expect(replaced.tokensUsed).toBe(0)
    await store.accrueSnapshot("s", {
      cost: 0.02,
      tokens: { input: 3, output: 4, reasoning: 5, cache: { read: 6, write: 7 } },
    })
    const goal = store.get("s") as NonNullable<ReturnType<GoalStore["get"]>>
    expect(goal.tokensUsed).toBe(10)
    expect(goal.costUsed).toBeCloseTo(0.01, 10)
    expect(goal.status).toBe("active")
  } finally {
    await cleanup()
  }
})
