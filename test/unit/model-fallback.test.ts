import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import {
  DEFAULT_MODEL_FALLBACK,
  type FallbackPolicy,
  type FallbackSwitchRecord,
  fallbackCandidatePermitted,
  fallbackDecision,
  type ModelFallbackConfig,
  mountModelFallback,
} from "../../src/config/model-fallback"
import { type ResolvedOptions, resolveOptions } from "../../src/config/resolve"
import { type OmoOptions, OptionsError, parseOptions } from "../../src/config/schema"
import type { ModelRef } from "../../src/contracts"

// Parity gap #2 (HIGH): reactive model/runtime fallback on the SDK's
// session.hook("retry"). A pure, hostless decision picks the next candidate
// from the configured per-profile chain, filtered by the SAME allowlists
// model.request enforces (assertAgentModelAllowed). No candidate → the host's
// own decision stands untouched: fail-closed is preserved, the original error
// is never swallowed. Default off registers no hook at all.

const deep: ModelRef = { providerID: "p", modelID: "deep", variant: "high" }
const fast: ModelRef = { providerID: "p", modelID: "fast" }
const turbo: ModelRef = { providerID: "q", modelID: "turbo" }

const unconstrained: FallbackPolicy = { profiles: [] }

const enabled: ModelFallbackConfig = {
  enabled: true,
  delayMs: 777,
  maxAttempts: 3,
  profiles: { executor: [fast, turbo] },
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

describe("fallbackDecision (pure guard, hostless)", () => {
  test("refusals carry exact reasons in guard order", () => {
    expect(
      fallbackDecision({ ...enabled, enabled: false }, unconstrained, {
        agentID: "executor",
        model: deep,
        attempt: 1,
      }),
    ).toEqual({ action: "none", reason: "disabled" })
    expect(
      fallbackDecision(enabled, unconstrained, {
        agentID: "researcher",
        model: deep,
        attempt: 1,
      }),
    ).toEqual({ action: "none", reason: "unconfigured-profile" })
    expect(
      fallbackDecision(enabled, unconstrained, {
        agentID: "executor",
        model: deep,
        attempt: 3,
      }),
    ).toEqual({ action: "none", reason: "attempt-cap" })
    expect(
      fallbackDecision(enabled, unconstrained, {
        agentID: "executor",
        model: turbo,
        attempt: 1,
      }),
    ).toEqual({ action: "none", reason: "exhausted" })
  })

  test("the failed model is never re-selected and the chain advances positionally", () => {
    const request = (model: ModelRef, attempt = 1) => ({
      agentID: "executor",
      model,
      attempt,
    })
    // Failed model outside the chain: first chain entry is the candidate.
    expect(fallbackDecision(enabled, unconstrained, request(deep))).toEqual({
      action: "switch",
      model: fast,
      delayMs: 777,
    })
    // Failed model is the first entry: the candidate is the next one.
    expect(fallbackDecision(enabled, unconstrained, request(fast))).toEqual({
      action: "switch",
      model: turbo,
      delayMs: 777,
    })
    // Failed model is the last entry: nothing after it.
    expect(fallbackDecision(enabled, unconstrained, request(turbo))).toEqual({
      action: "none",
      reason: "exhausted",
    })
    // Repeated failures of the same model are idempotent: same verdict.
    expect(fallbackDecision(enabled, unconstrained, request(fast, 2))).toEqual({
      action: "switch",
      model: turbo,
      delayMs: 777,
    })
    // One-entry chain: a failure of any other model still has a candidate...
    const single: ModelFallbackConfig = {
      ...enabled,
      profiles: { executor: [turbo] },
    }
    expect(fallbackDecision(single, unconstrained, request(deep))).toEqual({
      action: "switch",
      model: turbo,
      delayMs: 777,
    })
    // ...but a failure of the only entry is exhausted.
    expect(fallbackDecision(single, unconstrained, request(turbo))).toEqual({
      action: "none",
      reason: "exhausted",
    })
  })

  test("a candidate outside the allowlists is never selected; both layers constrain", () => {
    const policy: FallbackPolicy = {
      allowedModels: [fast, deep],
      profiles: [{ id: "executor", allowedModels: [fast] }],
    }
    // turbo fails the global layer; deep passes global but fails the profile layer.
    const chain: ModelRef[] = [turbo, deep, fast]
    const config: ModelFallbackConfig = {
      ...enabled,
      profiles: { executor: chain },
    }
    expect(
      fallbackDecision(config, policy, {
        agentID: "executor",
        model: deep,
        attempt: 1,
      }),
    ).toEqual({ action: "switch", model: fast, delayMs: 777 })
    // Every remaining candidate is blocked: no selection, exact reason.
    const blocked: FallbackPolicy = {
      allowedModels: [deep],
      profiles: [{ id: "executor", allowedModels: [turbo] }],
    }
    expect(
      fallbackDecision(config, blocked, {
        agentID: "executor",
        model: deep,
        attempt: 1,
      }),
    ).toEqual({ action: "none", reason: "exhausted" })
  })

  test("the switch stops at the attempt cap even when the chain has candidates left", () => {
    for (const attempt of [3, 4, 100]) {
      expect(
        fallbackDecision(enabled, unconstrained, {
          agentID: "executor",
          model: deep,
          attempt,
        }),
      ).toEqual({ action: "none", reason: "attempt-cap" })
    }
    // The cap admits both plausible host counter bases: 0- and 1-based.
    expect(
      fallbackDecision({ ...enabled, maxAttempts: 1 }, unconstrained, {
        agentID: "executor",
        model: deep,
        attempt: 0,
      }),
    ).toEqual({ action: "switch", model: fast, delayMs: 777 })
    expect(
      fallbackDecision({ ...enabled, maxAttempts: 1 }, unconstrained, {
        agentID: "executor",
        model: deep,
        attempt: 1,
      }),
    ).toEqual({ action: "none", reason: "attempt-cap" })
  })

  test("variants participate in candidate identity", () => {
    const deepLow: ModelRef = { providerID: "p", modelID: "deep", variant: "low" }
    const chain: ModelRef[] = [deepLow, fast]
    const config: ModelFallbackConfig = {
      ...enabled,
      profiles: { executor: chain },
    }
    // deep#high failing is NOT deep#low failing: the first entry stays eligible.
    expect(
      fallbackDecision(config, unconstrained, {
        agentID: "executor",
        model: deep,
        attempt: 1,
      }),
    ).toEqual({ action: "switch", model: deepLow, delayMs: 777 })
    // deep#low failing advances past it.
    expect(
      fallbackDecision(config, unconstrained, {
        agentID: "executor",
        model: deepLow,
        attempt: 1,
      }),
    ).toEqual({ action: "switch", model: fast, delayMs: 777 })
  })

  test("DEFAULT_MODEL_FALLBACK is off with exact spec thresholds", () => {
    expect(DEFAULT_MODEL_FALLBACK).toEqual({
      enabled: false,
      delayMs: 1_000,
      maxAttempts: 3,
      profiles: {},
    })
  })
})

describe("fallbackCandidatePermitted (same two layers as model.request)", () => {
  const candidate: ModelRef = { providerID: "p", modelID: "fast" }

  test("undefined layers constrain nothing; defined layers must contain the exact variant", () => {
    expect(fallbackCandidatePermitted({ profiles: [] }, "executor", candidate)).toBe(true)
    expect(
      fallbackCandidatePermitted({ profiles: [{ id: "executor" }] }, "executor", candidate),
    ).toBe(true)
    expect(
      fallbackCandidatePermitted(
        { allowedModels: [candidate], profiles: [] },
        "executor",
        candidate,
      ),
    ).toBe(true)
    expect(
      fallbackCandidatePermitted(
        { allowedModels: [{ providerID: "p", modelID: "fast", variant: "high" }], profiles: [] },
        "executor",
        candidate,
      ),
    ).toBe(false)
    expect(
      fallbackCandidatePermitted(
        {
          allowedModels: [candidate],
          profiles: [{ id: "executor", allowedModels: [turbo] }],
        },
        "executor",
        candidate,
      ),
    ).toBe(false)
    // The profile layer applies per ID: a chain for another profile is unconstrained by it.
    expect(
      fallbackCandidatePermitted(
        {
          allowedModels: [candidate],
          profiles: [{ id: "researcher", allowedModels: [turbo] }],
        },
        "executor",
        candidate,
      ),
    ).toBe(true)
  })
})

describe("mounted reactive fallback (session retry hook)", () => {
  interface HookModel {
    id: string
    providerID: string
    variant?: string
  }

  interface RetryDecision {
    retry: boolean
    delay?: number
  }

  interface RetryInput {
    sessionID: string
    agent: string
    model: HookModel
    error: { type: string; message: string }
    attempt: number
    decision: RetryDecision
  }

  type RetryHook = (input: RetryInput) => Promise<void>

  type SwitchCall = { sessionID: string; model: HookModel }

  function harness(apply?: (call: SwitchCall) => Promise<void>) {
    const hooks = new Map<string, RetryHook>()
    const disposed = new Set<string>()
    const switches: SwitchCall[] = []
    const session = {
      hook: async (name: string, handler: RetryHook) => {
        hooks.set(name, handler)
        return {
          dispose: async () => {
            disposed.add(name)
          },
        }
      },
      switchModel: async (call: SwitchCall) => {
        switches.push(call)
        if (apply) await apply(call)
      },
    }
    return { hooks, disposed, switches, context: { session } as unknown as Plugin.Context }
  }

  function hookOf(hooks: Map<string, RetryHook>, name: string): RetryHook {
    const found = hooks.get(name)
    if (!found) throw new Error(`missing ${name} hook`)
    return found
  }

  function failure(input: Partial<RetryInput> = {}): RetryInput {
    return {
      sessionID: "ses_1",
      agent: "executor",
      model: { id: "deep", providerID: "p", variant: "high" },
      error: { type: "api", message: "provider unavailable" },
      attempt: 1,
      decision: { retry: false },
      ...input,
    }
  }

  test("an enabled config registers the retry hook; the default registers nothing", async () => {
    const off = harness()
    const offCleanup = await mountModelFallback(
      off.context,
      { ...DEFAULT_MODEL_FALLBACK },
      unconstrained,
    )
    expect(off.hooks.size).toBe(0)
    await offCleanup()

    const on = harness()
    const cleanup = await mountModelFallback(on.context, enabled, unconstrained)
    expect([...on.hooks.keys()]).toEqual(["retry"])
    await cleanup()
    expect(on.disposed.has("retry")).toBe(true)
  })

  test("applies the next candidate: switchModel first, then the retry decision with the configured delay", async () => {
    const ctx = harness()
    const cleanup = await mountModelFallback(ctx.context, enabled, unconstrained)
    const input = failure()
    await hookOf(ctx.hooks, "retry")(input)
    expect(ctx.switches).toEqual([{ sessionID: "ses_1", model: { id: "fast", providerID: "p" } }])
    expect(input.decision).toEqual({ retry: true, delay: 777 })
    // The chain advances: the candidate that just failed is never re-selected.
    const second = failure({
      model: { id: "fast", providerID: "p" },
      attempt: 2,
    })
    await hookOf(ctx.hooks, "retry")(second)
    expect(ctx.switches).toEqual([
      { sessionID: "ses_1", model: { id: "fast", providerID: "p" } },
      { sessionID: "ses_1", model: { id: "turbo", providerID: "q" } },
    ])
    await cleanup()
  })

  test("no candidate leaves the host's own decision object untouched", async () => {
    const ctx = harness()
    const cleanup = await mountModelFallback(ctx.context, enabled, unconstrained)
    const hostDecision = { retry: false }
    const input = failure({ agent: "researcher", decision: hostDecision })
    await hookOf(ctx.hooks, "retry")(input)
    expect(input.decision).toBe(hostDecision)
    expect(ctx.switches).toEqual([])
    // Exhausted chain: same preservation of the host path.
    const exhausted = failure({ model: { id: "turbo", providerID: "q" } })
    await hookOf(ctx.hooks, "retry")(exhausted)
    expect(exhausted.decision).toEqual({ retry: false })
    expect(ctx.switches).toEqual([])
    // Attempt cap: same preservation of the host path.
    const capped = failure({ attempt: 3 })
    await hookOf(ctx.hooks, "retry")(capped)
    expect(capped.decision).toEqual({ retry: false })
    expect(ctx.switches).toEqual([])
    await cleanup()
  })

  test("a failed switch keeps the host decision instead of breaking the retry path", async () => {
    const ctx = harness(async () => {
      throw new Error("switch unavailable")
    })
    const cleanup = await mountModelFallback(ctx.context, enabled, unconstrained)
    const hostDecision = { retry: false }
    const input = failure({ decision: hostDecision })
    await hookOf(ctx.hooks, "retry")(input)
    expect(input.decision).toBe(hostDecision)
    expect(ctx.switches).toHaveLength(1)
    await cleanup()
  })

  test("applied switches are recorded through the onSwitch seam, which cannot break the hook", async () => {
    const records: FallbackSwitchRecord[] = []
    const ctx = harness()
    const cleanup = await mountModelFallback(ctx.context, enabled, unconstrained, {
      onSwitch: (record) => records.push(record),
    })
    await hookOf(ctx.hooks, "retry")(failure())
    expect(records).toEqual([
      {
        sessionID: "ses_1",
        agentID: "executor",
        from: { providerID: "p", modelID: "deep", variant: "high" },
        to: { providerID: "p", modelID: "fast" },
        attempt: 1,
      },
    ])
    // A throwing recorder is contained: the retry decision still lands.
    const hostile = harness()
    const hostileCleanup = await mountModelFallback(hostile.context, enabled, unconstrained, {
      onSwitch: () => {
        throw new Error("recorder broken")
      },
    })
    const input = failure()
    await hookOf(hostile.hooks, "retry")(input)
    expect(input.decision).toEqual({ retry: true, delay: 777 })
    await cleanup()
    await hostileCleanup()
  })

  test("mount-time allowlists are enforced: a blocked candidate is never switched to", async () => {
    const ctx = harness()
    const policy: FallbackPolicy = {
      allowedModels: [deep, turbo],
      profiles: [{ id: "executor", allowedModels: [turbo] }],
    }
    const cleanup = await mountModelFallback(ctx.context, enabled, policy)
    const input = failure()
    await hookOf(ctx.hooks, "retry")(input)
    // fast is not permitted by the profile layer; turbo is next after it.
    expect(ctx.switches).toEqual([{ sessionID: "ses_1", model: { id: "turbo", providerID: "q" } }])
    expect(input.decision).toEqual({ retry: true, delay: 777 })
    await cleanup()
  })
})

describe("config model_fallback (strict, fail-closed)", () => {
  test("defaults are off with exact thresholds and resolve unchanged", () => {
    const parsed: OmoOptions = parseOptions({ schemaVersion: 1 })
    expect(parsed.model_fallback).toEqual({
      enabled: false,
      delayMs: 1_000,
      maxAttempts: 3,
      profiles: {},
    })
    const resolved: ResolvedOptions = resolveOptions(parsed)
    expect(resolved.model_fallback).toEqual({
      enabled: false,
      delayMs: 1_000,
      maxAttempts: 3,
      profiles: {},
    })
  })

  test("explicit chains round-trip through parse and resolve", () => {
    const resolved = resolveOptions(
      parseOptions({
        schemaVersion: 1,
        model_fallback: {
          enabled: true,
          delayMs: 456,
          maxAttempts: 2,
          profiles: {
            executor: ["p/fast", { providerID: "q", modelID: "turbo", variant: "gpu" }],
          },
        },
      }),
    )
    expect(resolved.model_fallback).toEqual({
      enabled: true,
      delayMs: 456,
      maxAttempts: 2,
      profiles: {
        executor: [fast, { providerID: "q", modelID: "turbo", variant: "gpu" }],
      },
    })
  })

  test("chains may reference builtin and configured profile ids; disabled chains may stay configured", () => {
    const resolved = resolveOptions(
      parseOptions({
        schemaVersion: 1,
        profiles: [{ id: "custom-worker" }],
        model_fallback: {
          enabled: false,
          profiles: { "custom-worker": ["q/turbo"], oracle: ["p/fast"] },
        },
      }),
    )
    expect(resolved.model_fallback.profiles).toEqual({
      "custom-worker": [turbo],
      oracle: [fast],
    })
  })

  test("non-object values and unknown keys are rejected with field paths", () => {
    expectOptionError({ schemaVersion: 1, model_fallback: 1 }, "model_fallback")
    expectOptionError({ schemaVersion: 1, model_fallback: [] }, "model_fallback")
    expectOptionError({ schemaVersion: 1, model_fallback: "x" }, "model_fallback")
    expectOptionError(
      { schemaVersion: 1, model_fallback: { surprise: true } },
      "model_fallback.surprise",
    )
  })

  test("non-boolean enabled is rejected", () => {
    for (const value of [1, "on", null, [], {}]) {
      expectOptionError(
        { schemaVersion: 1, model_fallback: { enabled: value } },
        "model_fallback.enabled",
      )
    }
  })

  test("non-safe-integer or non-positive delay and attempt caps are rejected", () => {
    for (const value of [0, -1, 1.5, "2", null, 2 ** 53]) {
      expectOptionError(
        { schemaVersion: 1, model_fallback: { delayMs: value } },
        "model_fallback.delayMs",
      )
      expectOptionError(
        { schemaVersion: 1, model_fallback: { maxAttempts: value } },
        "model_fallback.maxAttempts",
      )
    }
  })

  test("profiles must be an object keyed by existing profiles with non-empty model chains", () => {
    expectOptionError(
      { schemaVersion: 1, model_fallback: { profiles: [] } },
      "model_fallback.profiles",
    )
    expectOptionError(
      { schemaVersion: 1, model_fallback: { profiles: "x" } },
      "model_fallback.profiles",
    )
    expectOptionError(
      { schemaVersion: 1, model_fallback: { profiles: { ghost: ["p/fast"] } } },
      "model_fallback.profiles.ghost",
    )
    expectOptionError(
      { schemaVersion: 1, model_fallback: { profiles: { executor: [] } } },
      "model_fallback.profiles.executor",
    )
    expectOptionError(
      { schemaVersion: 1, model_fallback: { profiles: { executor: "p/fast" } } },
      "model_fallback.profiles.executor",
    )
  })

  test("chain entries must be valid models without duplicates", () => {
    expectOptionError(
      {
        schemaVersion: 1,
        model_fallback: { profiles: { executor: [{ providerID: "", modelID: "fast" }] } },
      },
      "model_fallback.profiles.executor[0].providerID",
    )
    expectOptionError(
      { schemaVersion: 1, model_fallback: { profiles: { executor: [null] } } },
      "model_fallback.profiles.executor[0]",
    )
    expectOptionError(
      {
        schemaVersion: 1,
        model_fallback: { profiles: { executor: ["p/fast", "p/fast"] } },
      },
      "model_fallback.profiles.executor[1]",
    )
    // The same model with a different variant is not a duplicate.
    expect(
      resolveOptions(
        parseOptions({
          schemaVersion: 1,
          model_fallback: { profiles: { executor: ["p/deep#high", "p/deep#low"] } },
        }),
      ).model_fallback.profiles.executor,
    ).toEqual([deep, { providerID: "p", modelID: "deep", variant: "low" }])
  })

  test("chain entries outside the allowlists are rejected at parse time", () => {
    expectOptionError(
      {
        schemaVersion: 1,
        allowedModels: ["p/fast"],
        model_fallback: { profiles: { executor: ["q/turbo"] } },
      },
      "model_fallback.profiles.executor[0]",
    )
    expectOptionError(
      {
        schemaVersion: 1,
        profiles: [{ id: "custom-worker", allowedModels: ["p/fast"] }],
        model_fallback: { profiles: { "custom-worker": ["q/turbo"] } },
      },
      "model_fallback.profiles.custom-worker[0]",
    )
    // A profile-scoped allowlist constrains only its own profile's chain.
    expect(
      resolveOptions(
        parseOptions({
          schemaVersion: 1,
          profiles: [{ id: "custom-worker", allowedModels: ["p/fast"] }],
          model_fallback: { profiles: { "custom-worker": ["p/fast"], oracle: ["q/turbo"] } },
        }),
      ).model_fallback.profiles,
    ).toEqual({ "custom-worker": [fast], oracle: [turbo] })
  })

  test("enabled without chains is rejected; disabled without chains is the default", () => {
    expectOptionError(
      { schemaVersion: 1, model_fallback: { enabled: true } },
      "model_fallback.enabled",
    )
    expectOptionError(
      { schemaVersion: 1, model_fallback: { enabled: true, profiles: {} } },
      "model_fallback.enabled",
    )
    expect(
      resolveOptions(parseOptions({ schemaVersion: 1, model_fallback: {} })).model_fallback,
    ).toEqual(DEFAULT_MODEL_FALLBACK)
  })
})
