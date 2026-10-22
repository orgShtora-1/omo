import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseOptions } from "../../src/config/schema"
import { openGoalStore, validateObjective } from "../../src/goal/store"

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-"))
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

test("goal_enabled defaults to false and only accepts booleans", () => {
  expect((parseOptions({ schemaVersion: 1 }) as { goal_enabled?: boolean }).goal_enabled).toBe(
    false,
  )
  expect(
    (parseOptions({ schemaVersion: 1, goal_enabled: true }) as { goal_enabled?: boolean })
      .goal_enabled,
  ).toBe(true)
  expect(() => parseOptions({ schemaVersion: 1, goal_enabled: 1 })).toThrow()
})

test("validateObjective trims and enforces bounds", () => {
  expect(validateObjective("  ship the gate  ")).toBe("ship the gate")
  expect(() => validateObjective("   ")).toThrow("non-empty")
  expect(() => validateObjective("x".repeat(2001))).toThrow("2000")
})

test("set creates an active goal that get returns", async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const store = openGoalStore(dir)
    const goal = store.set("ses_a", "  Deliver parity  ")
    expect(goal.status).toBe("active")
    expect(goal.version).toBe(1)
    expect(goal.objective).toBe("Deliver parity")
    expect(goal.tokensUsed).toBe(0)
    expect(goal.timeUsedSeconds).toBe(0)
    expect(goal.createdAt).toBeTruthy()
    const loaded = store.get("ses_a")
    expect(loaded).not.toBeNull()
    expect(loaded?.objective).toBe("Deliver parity")
  } finally {
    await cleanup()
  }
})

test("set replaces the goal, keeps createdAt and returns to active", async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const store = openGoalStore(dir)
    const first = store.set("ses_a", "first objective")
    const completed = store.complete("ses_a")
    expect(completed?.status).toBe("complete")
    const replaced = store.set("ses_a", "second objective")
    expect(replaced?.status).toBe("active")
    expect(replaced?.objective).toBe("second objective")
    expect(replaced?.createdAt).toBe(first.createdAt)
  } finally {
    await cleanup()
  }
})

test("pause, resume and complete transitions persist", async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const store = openGoalStore(dir)
    store.set("ses_a", "objective")
    expect(store.pause("ses_a")?.status).toBe("paused")
    expect(store.get("ses_a")?.status).toBe("paused")
    expect(store.resume("ses_a")?.status).toBe("active")
    expect(store.complete("ses_a")?.status).toBe("complete")
    expect(store.get("ses_a")?.status).toBe("complete")
    expect(store.pause("missing")).toBeNull()
    expect(store.resume("missing")).toBeNull()
    expect(store.complete("missing")).toBeNull()
  } finally {
    await cleanup()
  }
})

test("get on a missing goal is null and clear removes the record", async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const store = openGoalStore(dir)
    expect(store.get("ses_x")).toBeNull()
    expect(store.clear("ses_x")).toBe(false)
    store.set("ses_x", "to clear")
    expect(store.clear("ses_x")).toBe(true)
    expect(store.get("ses_x")).toBeNull()
    expect(store.clear("ses_x")).toBe(false)
  } finally {
    await cleanup()
  }
})

test("a corrupt goal file is treated as absent", async () => {
  const { dir, cleanup } = await tempDir()
  try {
    writeFileSync(join(dir, "ses_bad.json"), "{not json", "utf8")
    const store = openGoalStore(dir)
    expect(store.get("ses_bad")).toBeNull()
  } finally {
    await cleanup()
  }
})

test("goals survive a store restart", async () => {
  const { dir, cleanup } = await tempDir()
  try {
    openGoalStore(dir).set("ses_r", "persist me")
    const reopened = openGoalStore(dir)
    expect(reopened.get("ses_r")?.objective).toBe("persist me")
    expect(reopened.get("ses_r")?.status).toBe("active")
  } finally {
    await cleanup()
  }
})

test("invalid persisted goal status, objective, and continuation count fail closed", async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const store = openGoalStore(dir)
    const original = store.set("ses_bad", "Valid objective")
    for (const patch of [
      { status: "running" },
      { objective: " " },
      { continuations: 0.5 },
      { continuations: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      writeFileSync(join(dir, "ses_bad.json"), JSON.stringify({ ...original, ...patch }), "utf8")
      expect(store.get("ses_bad")).toBeNull()
    }
  } finally {
    await cleanup()
  }
})

test("token aggregate overflow preserves the readable goal", async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const store = openGoalStore(dir)
    store.set("ses_usage", "Keep a valid record")
    // Two individually valid counters can still total Infinity, so the difference
    // between two such reports is NaN and must be refused instead of stored.
    const usage = {
      cost: 0,
      tokens: {
        input: Number.MAX_VALUE,
        output: Number.MAX_VALUE,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }
    const original = store.accrueSnapshot("ses_usage", usage)
    expect(() => store.accrueSnapshot("ses_usage", usage)).toThrow("invalid-usage: aggregate")
    expect(openGoalStore(dir).get("ses_usage")).toEqual(original)
  } finally {
    await cleanup()
  }
})

test("a repeated maximum-cost report accrues nothing instead of overflowing", async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const store = openGoalStore(dir)
    store.set("ses_usage", "Keep a valid record")
    const usage = {
      cost: Number.MAX_VALUE,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    store.accrueSnapshot("ses_usage", usage)
    // A cumulative snapshot can only ever grow by at most one report, so a
    // maximum-cost report cannot overflow the lifetime total on its own.
    expect(store.accrueSnapshot("ses_usage", usage)?.costUsed).toBe(0)
    expect(openGoalStore(dir).get("ses_usage")?.costUsed).toBe(0)
  } finally {
    await cleanup()
  }
})

test("goals are isolated per session", async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const store = openGoalStore(dir)
    store.set("ses_one", "objective one")
    store.set("ses_two", "objective two")
    expect(store.get("ses_one")?.objective).toBe("objective one")
    expect(store.get("ses_two")?.objective).toBe("objective two")
    store.clear("ses_one")
    expect(store.get("ses_one")).toBeNull()
    expect(store.get("ses_two")?.objective).toBe("objective two")
  } finally {
    await cleanup()
  }
})
