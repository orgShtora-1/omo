import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGoalContinuation, MAX_CONTINUATIONS } from "../../src/goal/continuation"
import { type GoalStore, openGoalStore } from "../../src/goal/store"
import { rmSyncRetry } from "./test-utils"

function tempStore(): { dir: string; store: GoalStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "omo-goal-cont-"))
  const store = openGoalStore(dir)
  return {
    dir,
    store,
    cleanup: () => {
      store.close()
      rmSyncRetry(dir)
    },
  }
}

function dbPath(dir: string) {
  return join(dir, "goal.db")
}

const usageTokens = { input: 100, output: 50, reasoning: 10, cache: { read: 0, write: 0 } }

test("accrueSnapshot counts only the increase over the previous cumulative report", () => {
  const { store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    // The first report only establishes the baseline, so it accrues nothing.
    const first = store.accrueSnapshot("s", { cost: 0.05, tokens: usageTokens })
    expect(first?.tokensUsed).toBe(0)
    expect(first?.costUsed).toBe(0)
    const second = store.accrueSnapshot("s", {
      cost: 0.07,
      tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 0, write: 0 } },
    })
    expect(second?.tokensUsed).toBe(160)
    expect(second?.costUsed).toBeCloseTo(0.02)
  } finally {
    cleanup()
  }
})

test("accrueSnapshot returns null without a goal and rejects invalid usage", () => {
  const { store, cleanup } = tempStore()
  try {
    expect(store.accrueSnapshot("ghost", { cost: 0.01, tokens: usageTokens })).toBeNull()
    store.set("s", "Ship parity gate")
    expect(() => store.accrueSnapshot("s", { cost: -1, tokens: usageTokens })).toThrow(
      "invalid-usage",
    )
    expect(() =>
      store.accrueSnapshot("s", { cost: 0, tokens: { ...usageTokens, input: Number.NaN } }),
    ).toThrow("invalid-usage")
    expect(store.get("s")?.tokensUsed).toBe(0)
  } finally {
    cleanup()
  }
})

test("legacy goal records without usage counters read with zero defaults", () => {
  const { dir, store, cleanup } = tempStore()
  try {
    const now = new Date().toISOString()
    const db = new Database(dbPath(dir))
    db.run(
      `INSERT INTO omo_goals (session_id, objective, status, created_at, updated_at, tokens_used, time_used_seconds, cost_used, continuations)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["legacy", "Old objective", "active", now, now, 5, 0, 0, 0],
    )
    db.close()
    const goal = store.get("legacy")
    expect(goal?.tokensUsed).toBe(5)
    expect(goal?.costUsed).toBe(0)
    expect(goal?.continuations).toBe(0)
  } finally {
    cleanup()
  }
})

test("idle with an active goal re-injects the objective once", async () => {
  const { store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    const prompts: Array<{ sessionID: string; text: string }> = []
    const continuation = createGoalContinuation({
      store,
      prompt: async (sessionID, text) => {
        prompts.push({ sessionID, text })
      },
    })
    const outcome = await continuation.handleEvent({
      type: "session.idle",
      data: { sessionID: "s" },
    })
    expect(outcome).toEqual({ continued: true, sessionID: "s" })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.sessionID).toBe("s")
    expect(prompts[0]?.text).toContain("Ship parity gate")
    expect(store.get("s")?.continuations).toBe(1)
  } finally {
    cleanup()
  }
})

test("continuation stops at the cap and auto-pauses the goal", async () => {
  const { store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    let prompts = 0
    const continuation = createGoalContinuation({
      store,
      prompt: async () => {
        prompts++
      },
    })
    for (let round = 0; round < MAX_CONTINUATIONS; round++) {
      const outcome = await continuation.handleEvent({
        type: "session.idle",
        data: { sessionID: "s" },
      })
      expect(outcome).toEqual({ continued: true, sessionID: "s" })
    }
    expect(prompts).toBe(MAX_CONTINUATIONS)
    const capped = await continuation.handleEvent({
      type: "session.idle",
      data: { sessionID: "s" },
    })
    expect(capped).toEqual({ continued: false })
    expect(store.get("s")?.status).toBe("paused")
    // Re-arming via resume allows one more continuation round.
    store.resume("s")
    const rearmed = await continuation.handleEvent({
      type: "session.idle",
      data: { sessionID: "s" },
    })
    expect(rearmed).toEqual({ continued: true, sessionID: "s" })
  } finally {
    cleanup()
  }
})

test("the continuation prompt carries the session's live work context", async () => {
  const { store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    const prompts: string[] = []
    const continuation = createGoalContinuation({
      store,
      prompt: async (_sessionID, text) => {
        prompts.push(text)
      },
      work: (sessionID) => (sessionID === "s" ? "[omo work] active work w1" : null),
    })
    expect(
      await continuation.handleEvent({ type: "session.idle", data: { sessionID: "s" } }),
    ).toEqual({ continued: true, sessionID: "s" })
    expect(prompts[0]).toContain("Ship parity gate")
    expect(prompts[0]).toContain("[omo work] active work w1")
    // A missing or failing work summary must never block the continuation.
    const bare = createGoalContinuation({
      store: (() => {
        store.resume("s")
        return store
      })(),
      prompt: async (_sessionID, text) => {
        prompts.push(text)
      },
    })
    expect(await bare.handleEvent({ type: "session.idle", data: { sessionID: "s" } })).toEqual({
      continued: true,
      sessionID: "s",
    })
    expect(prompts[1]).not.toContain("[omo work]")
    const broken = createGoalContinuation({
      store: (() => {
        store.resume("s")
        return store
      })(),
      prompt: async (_sessionID, text) => {
        prompts.push(text)
      },
      work: () => {
        throw new Error("corrupt record")
      },
    })
    expect(await broken.handleEvent({ type: "session.idle", data: { sessionID: "s" } })).toEqual({
      continued: true,
      sessionID: "s",
    })
    expect(prompts[2]).not.toContain("[omo work")
  } finally {
    cleanup()
  }
})

test("paused, complete, missing goals and foreign events never prompt", async () => {
  const { store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    let prompts = 0
    const continuation = createGoalContinuation({
      store,
      prompt: async () => {
        prompts++
      },
    })
    store.pause("s")
    expect(
      await continuation.handleEvent({ type: "session.idle", data: { sessionID: "s" } }),
    ).toEqual({ continued: false })
    store.resume("s")
    store.complete("s")
    expect(
      await continuation.handleEvent({ type: "session.idle", data: { sessionID: "s" } }),
    ).toEqual({ continued: false })
    expect(
      await continuation.handleEvent({ type: "session.idle", data: { sessionID: "ghost" } }),
    ).toEqual({ continued: false })
    expect(
      await continuation.handleEvent({ type: "session.created", data: { sessionID: "s" } }),
    ).toEqual({ continued: false })
    expect(prompts).toBe(0)
  } finally {
    cleanup()
  }
})

test("usage events accrue through the continuation without prompting", async () => {
  const { store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    let prompts = 0
    const continuation = createGoalContinuation({
      store,
      prompt: async () => {
        prompts++
      },
    })
    // The first host report is cumulative, so it only establishes the baseline.
    const outcome = await continuation.handleEvent({
      type: "session.usage.updated",
      data: {
        sessionID: "s",
        cost: 0.01,
        tokens: { ...usageTokens, input: 1, output: 2, reasoning: 3 },
      },
    })
    expect(outcome).toEqual({ continued: false })
    expect(prompts).toBe(0)
    expect(store.get("s")?.tokensUsed).toBe(0)
    expect(store.get("s")?.costUsed).toBe(0)
    // The next cumulative report accrues only its increase.
    await continuation.handleEvent({
      type: "session.usage.updated",
      data: {
        sessionID: "s",
        cost: 0.03,
        tokens: { ...usageTokens, input: 4, output: 5, reasoning: 6 },
      },
    })
    expect(store.get("s")?.tokensUsed).toBe(9)
    expect(store.get("s")?.costUsed).toBeCloseTo(0.02)
    // Malformed usage on the advisory stream is ignored, never thrown.
    const malformed = await continuation.handleEvent({
      type: "session.usage.updated",
      data: { sessionID: "s", cost: "free", tokens: usageTokens },
    })
    expect(malformed).toEqual({ continued: false })
    expect(store.get("s")?.tokensUsed).toBe(9)
    expect(store.get("s")?.costUsed).toBeCloseTo(0.02)
  } finally {
    cleanup()
  }
})

test("ambiguous prompt failure consumes its reservation and pauses instead of retrying", async () => {
  const { store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    let calls = 0
    const continuation = createGoalContinuation({
      store,
      prompt: async () => {
        calls++
        throw new Error("session gone")
      },
    })
    const outcome = await continuation.handleEvent({
      type: "session.idle",
      data: { sessionID: "s" },
    })
    expect(outcome).toEqual({ continued: false })
    expect(calls).toBe(1)
    expect(store.get("s")?.continuations).toBe(1)
    expect(store.get("s")?.status).toBe("paused")
    await continuation.handleEvent({ type: "session.idle", data: { sessionID: "s" } })
    expect(calls).toBe(1)
  } finally {
    cleanup()
  }
})

test("concurrent idle events reserve one continuation before prompt admission", {
  timeout: 30000,
}, async () => {
  const { dir, store, cleanup } = tempStore()
  let release = () => {}
  const admitted = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    store.set("s", "Ship parity gate")
    let calls = 0
    const continuation = createGoalContinuation({
      store,
      prompt: async () => {
        calls++
        await admitted
      },
    })
    const first = continuation.handleEvent({ type: "session.idle", data: { sessionID: "s" } })
    const second = continuation.handleEvent({ type: "session.idle", data: { sessionID: "s" } })
    expect(calls).toBe(1)
    const verifyStore = openGoalStore(dir)
    expect(verifyStore.get("s")?.continuations).toBe(1)
    verifyStore.close()
    release()
    expect(await first).toEqual({ continued: true, sessionID: "s" })
    expect(await second).toEqual({ continued: false })
  } finally {
    release()
    cleanup()
  }
})

test("reopened continuation pauses an unresolved admission instead of submitting again", {
  timeout: 30000,
}, async () => {
  const { dir, store, cleanup } = tempStore()
  let release = () => {}
  const admitted = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    store.set("s", "Ship parity gate")
    const firstService = createGoalContinuation({ store, prompt: async () => admitted })
    const first = firstService.handleEvent({ type: "session.idle", data: { sessionID: "s" } })
    let retries = 0
    const reopened = openGoalStore(dir)
    const recovered = createGoalContinuation({
      store: reopened,
      prompt: async () => {
        retries++
      },
    })
    expect(await recovered.handleEvent({ type: "session.idle", data: { sessionID: "s" } })).toEqual(
      { continued: false },
    )
    expect(retries).toBe(0)
    expect(reopened.get("s")?.status).toBe("paused")
    expect(reopened.get("s")?.continuations).toBe(1)
    release()
    await first
    expect(reopened.get("s")?.status).toBe("paused")
    reopened.close()
  } finally {
    release()
    cleanup()
  }
})

test("continuation rejects unbounded or invalid configured limits", () => {
  const { store, cleanup } = tempStore()
  try {
    for (const maxContinuations of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createGoalContinuation({ store, prompt: async () => {}, maxContinuations }),
      ).toThrow("invalid-continuation-limit")
    }
  } finally {
    cleanup()
  }
})

test.each([false, true])(
  "stale admission failure=%s cannot settle a rearmed continuation",
  { timeout: 30000 },
  async (failed) => {
    const { dir, store, cleanup } = tempStore()
    let releaseFirst = () => {}
    let releaseSecond = () => {}
    const firstAdmission = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondAdmission = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    try {
      store.set("s", "First objective")
      const first = createGoalContinuation({
        store,
        prompt: async () => {
          await firstAdmission
          if (failed) throw new Error("old admission failed")
        },
      }).handleEvent({ type: "session.idle", data: { sessionID: "s" } })
      store.set("s", "Replacement objective")
      const secondStore = openGoalStore(dir)
      const second = createGoalContinuation({
        store: secondStore,
        prompt: async () => secondAdmission,
      }).handleEvent({ type: "session.idle", data: { sessionID: "s" } })
      releaseFirst()
      await first
      const verifyStore = openGoalStore(dir)
      const persisted = verifyStore.get("s")
      expect(persisted?.objective).toBe("Replacement objective")
      expect(persisted?.status).toBe("active")
      expect(persisted?.continuationPending).toBe(true)
      verifyStore.close()
      releaseSecond()
      await second
      expect(store.get("s")?.continuationPending).toBe(false)
      secondStore.close()
    } finally {
      releaseFirst()
      releaseSecond()
      cleanup()
    }
  },
)
