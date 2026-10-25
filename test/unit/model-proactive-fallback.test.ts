import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { FallbackPolicy } from "../../src/config/model-fallback"
import {
  DEFAULT_PROACTIVE_MODEL_FALLBACK,
  mountProactiveModelFallback,
  type ProactiveModelFallbackConfig,
  proactiveVerdict,
} from "../../src/config/model-proactive-fallback"
import { type ResolvedOptions, resolveOptions } from "../../src/config/resolve"
import { type OmoOptions, OptionsError, parseOptions } from "../../src/config/schema"
import type { ModelRef } from "../../src/contracts"

const deep: ModelRef = { providerID: "p", modelID: "deep", variant: "high" }
const fast: ModelRef = { providerID: "p", modelID: "fast" }
const turbo: ModelRef = { providerID: "q", modelID: "turbo" }

const unconstrained: FallbackPolicy = { profiles: [] }

const enabled: ProactiveModelFallbackConfig = {
  enabled: true,
  triggerPct: 0.9,
  cooldownMs: 30_000,
}

describe("proactiveVerdict (pure decision)", () => {
  test("returns empty when disabled or in flight", () => {
    const state = { inflight: false, lastAt: undefined }
    expect(
      proactiveVerdict(
        { ...enabled, enabled: false },
        unconstrained,
        "executor",
        deep,
        950,
        1000,
        [deep, fast],
        1000,
        state,
      ),
    ).toEqual({})

    expect(
      proactiveVerdict(enabled, unconstrained, "executor", deep, 950, 1000, [deep, fast], 1000, {
        inflight: true,
        lastAt: undefined,
      }),
    ).toEqual({})
  })

  test("triggers switch when context exceeds triggerPct of limit", () => {
    const state = { inflight: false, lastAt: undefined }
    // 850 tokens < 900 threshold (90% of 1000) -> no switch
    expect(
      proactiveVerdict(
        enabled,
        unconstrained,
        "executor",
        deep,
        850,
        1000,
        [deep, fast, turbo],
        1000,
        state,
      ),
    ).toEqual({})

    // 950 tokens >= 900 threshold -> switch to next
    expect(
      proactiveVerdict(
        enabled,
        unconstrained,
        "executor",
        deep,
        950,
        1000,
        [deep, fast, turbo],
        1000,
        state,
      ),
    ).toEqual({ switch: fast, delayMs: 30_000 })
  })

  test("respects cooldown between proactive switches", () => {
    const state = { inflight: false, lastAt: 1000 }
    // 5 seconds later: still in cooldown (30s)
    expect(
      proactiveVerdict(
        enabled,
        unconstrained,
        "executor",
        deep,
        950,
        1000,
        [deep, fast],
        6000,
        state,
      ),
    ).toEqual({})

    // 35 seconds later: cooldown expired
    expect(
      proactiveVerdict(
        enabled,
        unconstrained,
        "executor",
        deep,
        950,
        1000,
        [deep, fast],
        36000,
        state,
      ),
    ).toEqual({ switch: fast, delayMs: 30_000 })
  })

  test("filters candidates against allowlists", () => {
    const policy: FallbackPolicy = {
      allowedModels: [deep, turbo],
      profiles: [{ id: "executor", allowedModels: [turbo] }],
    }
    const state = { inflight: false, lastAt: undefined }
    // fast is not allowed, so it skips to turbo
    expect(
      proactiveVerdict(
        enabled,
        policy,
        "executor",
        deep,
        950,
        1000,
        [deep, fast, turbo],
        1000,
        state,
      ),
    ).toEqual({ switch: turbo, delayMs: 30_000 })
  })

  test("returns empty when chain is exhausted", () => {
    const state = { inflight: false, lastAt: undefined }
    expect(
      proactiveVerdict(
        enabled,
        unconstrained,
        "executor",
        turbo,
        950,
        1000,
        [deep, fast, turbo],
        1000,
        state,
      ),
    ).toEqual({})
  })
})

describe("proactive_model_fallback config parsing", () => {
  test("defaults to disabled with exact spec values", () => {
    const parsed = parseOptions({ schemaVersion: 1 })
    expect(parsed.proactive_model_fallback).toEqual(DEFAULT_PROACTIVE_MODEL_FALLBACK)
    const resolved = resolveOptions(parsed)
    expect(resolved.proactive_model_fallback).toEqual(DEFAULT_PROACTIVE_MODEL_FALLBACK)
  })

  test("accepts valid custom values", () => {
    const parsed = parseOptions({
      schemaVersion: 1,
      proactive_model_fallback: {
        enabled: true,
        triggerPct: 0.85,
        cooldownMs: 45_000,
      },
    })
    expect(parsed.proactive_model_fallback).toEqual({
      enabled: true,
      triggerPct: 0.85,
      cooldownMs: 45_000,
    })
  })

  test("rejects invalid triggerPct values", () => {
    expect(() =>
      parseOptions({
        schemaVersion: 1,
        proactive_model_fallback: { triggerPct: -0.1 },
      }),
    ).toThrow(OptionsError)

    expect(() =>
      parseOptions({
        schemaVersion: 1,
        proactive_model_fallback: { triggerPct: 1.5 },
      }),
    ).toThrow(OptionsError)

    expect(() =>
      parseOptions({
        schemaVersion: 1,
        proactive_model_fallback: { triggerPct: 0 },
      }),
    ).toThrow(OptionsError)
  })
})
