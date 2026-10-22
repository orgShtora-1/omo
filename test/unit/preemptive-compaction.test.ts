import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { type ResolvedOptions, resolveOptions } from "../../src/config/resolve"
import { type OmoOptions, OptionsError, parseOptions } from "../../src/config/schema"
import {
  DEFAULT_PREEMPTIVE_COMPACTION,
  mountContext,
  type PreemptiveCompactionConfig,
  preemptiveVerdict,
} from "../../src/context/compaction"
import type { Plan, PlanRepository, Scope } from "../../src/contracts"
import { createPlan } from "../../src/plans/model"

// Parity gap #3 (upstream preemptiveCompaction): threshold-based compaction
// on the EXISTING context hook, guarded by a pure clock-injected decision so
// a compact-loop is impossible (in-flight mark + per-session cooldown).

interface HookSystemPart {
  type: string
  text: string
}

interface HookInput {
  sessionID: string
  system: HookSystemPart[]
  result?: { summary: string }
}

type Hook = (input: HookInput) => Promise<void>

function harness(queue?: (input: { sessionID: string }) => Promise<unknown>) {
  const hooks = new Map<string, Hook>()
  const compacts: { sessionID: string }[] = []
  const session = {
    hook: async (name: string, handler: Hook) => {
      hooks.set(name, handler)
      return { dispose: async () => {} }
    },
    compact: async (input: { sessionID: string }) => {
      compacts.push(input)
      return queue ? await queue(input) : undefined
    },
  }
  return {
    hooks,
    compacts,
    session,
    context: { session } as unknown as Plugin.Context,
  }
}

function hookOf(hooks: Map<string, Hook>, name: string): Hook {
  const found = hooks.get(name)
  if (!found) throw new Error(`missing ${name} hook`)
  return found
}

const emptyRepository = {
  list: async (): Promise<readonly Plan[]> => [],
} as unknown as PlanRepository
const scopeFor = async (): Promise<Scope> => ({
  projectID: "project",
  locationID: "location",
  parentSessionID: "parent",
})

function clock(startAt = 1_000_000) {
  let tick = startAt
  return {
    now: () => tick,
    advance: (ms: number) => {
      tick += ms
    },
  }
}

const policy: PreemptiveCompactionConfig = { enabled: true, thresholdChars: 100, cooldownMs: 1_000 }

function bigInput(sessionID = "parent"): HookInput {
  return { sessionID, system: [{ type: "text", text: "x".repeat(150) }] }
}

function expectOptionError(input: unknown, path: string): void {
  try {
    const parsed = parseOptions(input)
    resolveOptions(parsed)
  } catch (err) {
    expect(err).toBeInstanceOf(OptionsError)
    expect((err as OptionsError).path).toBe(path)
    return
  }
  throw new Error(`esperava OptionsError em ${path}, mas parseou`)
}

describe("preemptiveVerdict (pure guard, injected clock)", () => {
  const config: PreemptiveCompactionConfig = {
    enabled: true,
    thresholdChars: 100,
    cooldownMs: 1_000,
  }

  test("refusals carry exact reasons in guard order", () => {
    expect(
      preemptiveVerdict(
        { ...config, enabled: false },
        { inflight: false, lastAt: undefined },
        1_000,
        5_000,
      ),
    ).toEqual({ trigger: false, reason: "disabled" })
    expect(preemptiveVerdict(config, { inflight: true, lastAt: 4_999 }, 1_000, 5_000)).toEqual({
      trigger: false,
      reason: "in-flight",
    })
    expect(preemptiveVerdict(config, { inflight: false, lastAt: undefined }, 100, 5_000)).toEqual({
      trigger: false,
      reason: "below-threshold",
    })
    expect(preemptiveVerdict(config, { inflight: false, lastAt: 4_999 }, 1_000, 5_000)).toEqual({
      trigger: false,
      reason: "cooldown",
    })
  })

  test("triggers exactly above the threshold and exactly at elapsed cooldown", () => {
    expect(preemptiveVerdict(config, { inflight: false, lastAt: undefined }, 101, 5_000)).toEqual({
      trigger: true,
    })
    expect(preemptiveVerdict(config, { inflight: false, lastAt: 4_000 }, 1_000, 5_000)).toEqual({
      trigger: true,
    })
  })

  test("DEFAULT_PREEMPTIVE_COMPACTION is off with exact spec thresholds", () => {
    expect(DEFAULT_PREEMPTIVE_COMPACTION).toEqual({
      enabled: false,
      thresholdChars: 120_000,
      cooldownMs: 60_000,
    })
  })
})

describe("mounted preemptive compaction (existing context hook)", () => {
  test("queues one compaction per cycle: in-flight, observation and cooldown all refuse", async () => {
    const ctx = harness()
    const time = clock()
    const cleanup = await mountContext(ctx.context, emptyRepository, scopeFor, 12_000, {
      preemptive: policy,
      now: time.now,
    })
    const contextHook = hookOf(ctx.hooks, "context")
    const compactionHook = hookOf(ctx.hooks, "compaction")
    await contextHook(bigInput())
    expect(ctx.compacts).toEqual([{ sessionID: "parent" }])
    // The queued compaction has not been observed yet: a second request in the
    // same cycle must not queue another one.
    await contextHook(bigInput())
    expect(ctx.compacts).toHaveLength(1)
    // The host runs the queued compaction: the cycle is observed (even when
    // another hook owns the summary result) and re-arms the cooldown.
    await compactionHook({ sessionID: "parent", system: [], result: { summary: "host summary" } })
    await contextHook(bigInput())
    expect(ctx.compacts).toHaveLength(1)
    // Cooldown elapsed exactly: a still-oversized context may queue again.
    time.advance(1_000)
    await contextHook(bigInput())
    expect(ctx.compacts).toEqual([{ sessionID: "parent" }, { sessionID: "parent" }])
    await cleanup()
  })

  test("a mounted context without a preemptive policy never queues a compaction", async () => {
    const ctx = harness()
    const cleanup = await mountContext(ctx.context, emptyRepository, scopeFor)
    await hookOf(ctx.hooks, "context")(bigInput())
    expect(ctx.compacts).toEqual([])
    await cleanup()
  })

  test("a failed compact queue clears the in-flight mark and recovers after the cooldown", async () => {
    const ctx = harness(async () => {
      throw new Error("queue unavailable")
    })
    const time = clock()
    const cleanup = await mountContext(ctx.context, emptyRepository, scopeFor, 12_000, {
      preemptive: policy,
      now: time.now,
    })
    const contextHook = hookOf(ctx.hooks, "context")
    await contextHook(bigInput())
    expect(ctx.compacts).toHaveLength(1)
    // Still inside the cooldown window from the failed trigger.
    await contextHook(bigInput())
    expect(ctx.compacts).toHaveLength(1)
    time.advance(1_000)
    // The in-flight mark was cleared by the failure: the guard recovers.
    await contextHook(bigInput())
    expect(ctx.compacts).toHaveLength(2)
    await cleanup()
  })

  test("a host-owned compaction cycle is observed and rate-limits the same way", async () => {
    const ctx = harness()
    const time = clock()
    const cleanup = await mountContext(ctx.context, emptyRepository, scopeFor, 12_000, {
      preemptive: policy,
      now: time.now,
    })
    const contextHook = hookOf(ctx.hooks, "context")
    const compactionHook = hookOf(ctx.hooks, "compaction")
    // A user- or host-initiated compaction is observed before any summary work.
    await compactionHook({ sessionID: "parent", system: [] })
    await contextHook(bigInput())
    expect(ctx.compacts).toEqual([])
    time.advance(1_000)
    await contextHook(bigInput())
    expect(ctx.compacts).toEqual([{ sessionID: "parent" }])
    await cleanup()
  })

  test("rate limits are per session", async () => {
    const ctx = harness()
    const cleanup = await mountContext(ctx.context, emptyRepository, scopeFor, 12_000, {
      preemptive: policy,
      now: clock().now,
    })
    const contextHook = hookOf(ctx.hooks, "context")
    await contextHook(bigInput("parent"))
    await contextHook(bigInput("child-b"))
    expect(ctx.compacts).toEqual([{ sessionID: "parent" }, { sessionID: "child-b" }])
    await cleanup()
  })

  test("the threshold measures the context as built, after recovery injection", async () => {
    const plan = createPlan({
      id: "plan",
      projectID: "project",
      parentSessionID: "parent",
      at: 0,
      steps: [{ id: "next", objective: "Inspect artifact", dependencies: [] }],
    })
    const repository = {
      list: async (): Promise<readonly Plan[]> => [plan],
    } as unknown as PlanRepository
    const strictScope = async (sessionID: string): Promise<Scope> => {
      if (sessionID !== "parent") throw new Error("foreign-project")
      return { projectID: "project", locationID: "location", parentSessionID: "parent" }
    }
    const ctx = harness()
    const cleanup = await mountContext(ctx.context, repository, strictScope, 12_000, {
      preemptive: policy,
      now: clock().now,
    })
    const input: HookInput = {
      sessionID: "parent",
      system: [{ type: "text", text: "Host summary" }],
    }
    await hookOf(ctx.hooks, "context")(input)
    expect(input.system[1]?.text).toContain("Inspect artifact")
    expect(ctx.compacts).toEqual([{ sessionID: "parent" }])
    await cleanup()
  })
})

describe("config preemptive_compaction (strict, fail-closed)", () => {
  test("defaults are off with exact thresholds and resolve unchanged", () => {
    const parsed: OmoOptions = parseOptions({ schemaVersion: 1 })
    expect(parsed.preemptive_compaction).toEqual({
      enabled: false,
      thresholdChars: 120_000,
      cooldownMs: 60_000,
    })
    const resolved: ResolvedOptions = resolveOptions(parsed)
    expect(resolved.preemptive_compaction).toEqual({
      enabled: false,
      thresholdChars: 120_000,
      cooldownMs: 60_000,
    })
  })

  test("explicit values round-trip through parse and resolve", () => {
    const resolved = resolveOptions(
      parseOptions({
        schemaVersion: 1,
        preemptive_compaction: { enabled: true, thresholdChars: 456, cooldownMs: 789 },
      }),
    )
    expect(resolved.preemptive_compaction).toEqual({
      enabled: true,
      thresholdChars: 456,
      cooldownMs: 789,
    })
  })

  test("max safe integers are accepted", () => {
    const resolved = resolveOptions(
      parseOptions({
        schemaVersion: 1,
        preemptive_compaction: { thresholdChars: Number.MAX_SAFE_INTEGER, cooldownMs: 1 },
      }),
    )
    expect(resolved.preemptive_compaction).toEqual({
      enabled: false,
      thresholdChars: 9_007_199_254_740_991,
      cooldownMs: 1,
    })
  })

  test("non-object values and unknown keys are rejected with field paths", () => {
    expectOptionError({ schemaVersion: 1, preemptive_compaction: 1 }, "preemptive_compaction")
    expectOptionError({ schemaVersion: 1, preemptive_compaction: [] }, "preemptive_compaction")
    expectOptionError({ schemaVersion: 1, preemptive_compaction: "x" }, "preemptive_compaction")
    expectOptionError(
      { schemaVersion: 1, preemptive_compaction: { surprise: true } },
      "preemptive_compaction.surprise",
    )
  })

  test("non-boolean enabled is rejected", () => {
    for (const value of [1, "on", null, [], {}]) {
      expectOptionError(
        { schemaVersion: 1, preemptive_compaction: { enabled: value } },
        "preemptive_compaction.enabled",
      )
    }
  })

  test("non-safe-integer or non-positive thresholds are rejected", () => {
    for (const value of [0, -1, 1.5, "2", null, 2 ** 53]) {
      expectOptionError(
        { schemaVersion: 1, preemptive_compaction: { thresholdChars: value } },
        "preemptive_compaction.thresholdChars",
      )
      expectOptionError(
        { schemaVersion: 1, preemptive_compaction: { cooldownMs: value } },
        "preemptive_compaction.cooldownMs",
      )
    }
  })
})
