import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGoalContinuation } from "../../src/goal/continuation"
import { type GoalStore, openGoalStore } from "../../src/goal/store"

function tempStore(): { dir: string; store: GoalStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "omo-goal-usage-"))
  const store = openGoalStore(dir)
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const snapshot = (
  cost: number,
  input: number,
  output: number,
  reasoning: number,
  read = 0,
  write = 0,
) => ({
  cost,
  tokens: { input, output, reasoning, cache: { read, write } },
})

test("the first cumulative report only establishes a baseline", () => {
  const { store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    const goal = store.accrueSnapshot("s", snapshot(1.5, 900, 300, 100))
    expect(goal?.tokensUsed).toBe(0)
    expect(goal?.costUsed).toBe(0)
  } finally {
    cleanup()
  }
})

test("only the increase between cumulative reports is accrued, cache tokens included", () => {
  const { store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    store.accrueSnapshot("s", snapshot(1.5, 900, 300, 100, 4000, 20))
    const grown = store.accrueSnapshot("s", snapshot(1.75, 1000, 350, 120, 6000, 25))
    expect(grown?.tokensUsed).toBe(100 + 50 + 20 + 2000 + 5)
    expect(grown?.costUsed).toBeCloseTo(0.25)
    const again = store.accrueSnapshot("s", snapshot(1.75, 1000, 350, 120, 6000, 25))
    expect(again?.tokensUsed).toBe(grown?.tokensUsed)
    expect(again?.costUsed).toBeCloseTo(0.25)
  } finally {
    cleanup()
  }
})

test("a report below the baseline rebases without subtracting lifetime usage", () => {
  const { store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    store.accrueSnapshot("s", snapshot(2, 500, 200, 50))
    const grown = store.accrueSnapshot("s", snapshot(2.5, 700, 250, 60))
    expect(grown?.costUsed).toBeCloseTo(0.5)
    const rebased = store.accrueSnapshot("s", snapshot(0.1, 10, 5, 1))
    expect(rebased?.costUsed).toBeCloseTo(0.5)
    expect(rebased?.tokensUsed).toBe(grown?.tokensUsed)
    const afterRebase = store.accrueSnapshot("s", snapshot(0.2, 30, 15, 4))
    expect(afterRebase?.costUsed).toBeCloseTo(0.6)
  } finally {
    cleanup()
  }
})

test("the baseline survives reopening so a restart cannot recount earlier usage", () => {
  const { dir, store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    store.accrueSnapshot("s", snapshot(1, 400, 100, 20))
    store.accrueSnapshot("s", snapshot(1.2, 500, 120, 25))
    const reopened = openGoalStore(dir)
    const afterRestart = reopened.accrueSnapshot("s", snapshot(1.3, 600, 140, 30))
    expect(afterRestart?.costUsed).toBeCloseTo(0.3)
    // 125 accrued before the reopen plus 125 after it, never the full baseline twice.
    expect(afterRestart?.tokensUsed).toBe(2 * (100 + 20 + 5))
  } finally {
    cleanup()
  }
})

test("cumulative reports without a goal create no baseline record", () => {
  const { store, cleanup } = tempStore()
  try {
    expect(store.accrueSnapshot("ghost", snapshot(9, 9000, 900, 90))).toBeNull()
    store.set("s", "Ship parity gate")
    expect(store.accrueSnapshot("s", snapshot(9, 9000, 900, 90))?.tokensUsed).toBe(0)
  } finally {
    cleanup()
  }
})

test.each([
  { cost: -1, tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } } },
  {
    cost: 1,
    tokens: { input: Number.NaN, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
  },
  { cost: 1, tokens: { input: 1, output: 1, reasoning: 1, cache: { read: -1, write: 0 } } },
  { cost: 1, tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0 } } },
])("invalid cumulative report %j is refused without changing the goal", (report) => {
  const { store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    store.accrueSnapshot("s", snapshot(1, 100, 50, 10))
    expect(() => store.accrueSnapshot("s", report as never)).toThrow("invalid-usage")
    const goal = store.get("s")
    expect(goal?.costUsed).toBe(0)
    expect(goal?.tokensUsed).toBe(0)
  } finally {
    cleanup()
  }
})

test("continuation treats host usage reports as cumulative and ignores malformed ones", async () => {
  const { store, cleanup } = tempStore()
  try {
    store.set("s", "Ship parity gate")
    const continuation = createGoalContinuation({ store, prompt: async () => ({}) })
    const usage = (cost: number, input: number, output: number, read: number) => ({
      type: "session.usage.updated",
      data: {
        sessionID: "s",
        cost,
        tokens: { input, output, reasoning: 0, cache: { read, write: 0 } },
      },
    })
    await continuation.handleEvent(usage(0.1, 1000, 200, 5000))
    expect(store.get("s")?.costUsed).toBe(0)
    await continuation.handleEvent(usage(0.3, 1100, 250, 6000))
    expect(store.get("s")?.costUsed).toBeCloseTo(0.2)
    expect(store.get("s")?.tokensUsed).toBe(100 + 50 + 1000)
    await continuation.handleEvent(usage(0.3, 1100, 250, 6000))
    expect(store.get("s")?.tokensUsed).toBe(100 + 50 + 1000)
    // A non-numeric cost is refused on its own, with a complete cache payload:
    // otherwise this case would not isolate which field was invalid.
    const nonNumericCost = await continuation.handleEvent({
      type: "session.usage.updated",
      data: {
        sessionID: "s",
        cost: "free",
        tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
      },
    })
    expect(nonNumericCost).toEqual({ continued: false })
    expect(store.get("s")?.costUsed).toBeCloseTo(0.2)
    // A report whose cache counters fall below the baseline is a provider
    // reset, not usage to subtract: the goal rebases and accrues nothing.
    const cacheReset = await continuation.handleEvent({
      type: "session.usage.updated",
      data: { sessionID: "s", cost: 0.5, tokens: { input: 1200, output: 250, reasoning: 0 } },
    })
    expect(cacheReset).toEqual({ continued: false })
    expect(store.get("s")?.costUsed).toBeCloseTo(0.2)
    // A session whose host never reports cache counters still accrues: the
    // missing counters count as zero instead of discarding cost and tokens.
    store.set("c", "cache-less host")
    await continuation.handleEvent({
      type: "session.usage.updated",
      data: { sessionID: "c", cost: 0.5, tokens: { input: 10, output: 5, reasoning: 0 } },
    })
    expect(store.get("c")?.tokensUsed).toBe(0)
    await continuation.handleEvent({
      type: "session.usage.updated",
      data: { sessionID: "c", cost: 0.9, tokens: { input: 30, output: 5, reasoning: 0 } },
    })
    expect(store.get("c")?.tokensUsed).toBe(20)
    expect(store.get("c")?.costUsed).toBeCloseTo(0.4)
    // A partial cache payload is not a usable report and changes nothing.
    const partialCache = await continuation.handleEvent({
      type: "session.usage.updated",
      data: {
        sessionID: "s",
        cost: 9,
        tokens: { input: 9, output: 9, reasoning: 9, cache: { read: 9 } },
      },
    })
    expect(partialCache).toEqual({ continued: false })
    expect(store.get("s")?.costUsed).toBeCloseTo(0.2)
  } finally {
    cleanup()
  }
})
