import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { mountThinkMode } from "../../src/agents/think-mode"
import type { ProfileConfig } from "../../src/config/schema"

// ---------------------------------------------------------------------------
// mountThinkMode
// ---------------------------------------------------------------------------

describe("mountThinkMode", () => {
  function makeMockCtx(_profiles: ProfileConfig[]) {
    const hookCalls: Array<{ name: string; callback: (input: unknown) => void }> = []
    return {
      hookCalls,
      session: {
        hook: async (name: string, callback: (input: unknown) => void) => {
          hookCalls.push({ name, callback })
          return {
            dispose: async () => {
              const idx = hookCalls.findIndex((h) => h.callback === callback)
              if (idx !== -1) hookCalls.splice(idx, 1)
            },
          }
        },
      },
    } as unknown as Plugin.Context & { hookCalls: typeof hookCalls }
  }

  test("injects thinking config when profile has thinkMode enabled", async () => {
    const profiles: ProfileConfig[] = [
      { id: "hephaestus", mode: "subagent", allowWrite: false, thinkMode: true },
    ]
    const ctx = makeMockCtx(profiles)
    const { hookCalls } = ctx
    await mountThinkMode(ctx, profiles)

    // Simulate a context hook call for the hephaestus agent
    const hookCall = hookCalls.find((h) => h.name === "context")
    expect(hookCall).toBeDefined()

    const input = {
      sessionID: "test-session",
      agent: "hephaestus",
      model: { providerID: "anthropic", id: "claude-sonnet-4-20250514" },
      system: [],
      messages: [],
      options: {} as Record<string, unknown>,
    }
    hookCall?.callback(input)

    const providerOptions = (input.options.providerOptions ?? {}) as Record<string, unknown>
    expect(providerOptions.thinking).toEqual({ type: "enabled", budgetTokens: 4096 })
  })

  test("does not inject when profile does not have thinkMode", async () => {
    const profiles: ProfileConfig[] = [{ id: "hephaestus", mode: "subagent", allowWrite: false }]
    const ctx = makeMockCtx(profiles)
    const { hookCalls } = ctx
    await mountThinkMode(ctx, profiles)

    // No hook registered when no profile has thinkMode
    const hookCall = hookCalls.find((h) => h.name === "context")
    expect(hookCall).toBeUndefined()

    const input = {
      sessionID: "test-session",
      agent: "hephaestus",
      model: { providerID: "anthropic", id: "claude-sonnet-4-20250514" },
      system: [],
      messages: [],
      options: {} as Record<string, unknown>,
    }

    expect(input.options.providerOptions).toBeUndefined()
  })

  test("does not inject for unknown agent", async () => {
    const profiles: ProfileConfig[] = [
      { id: "hephaestus", mode: "subagent", allowWrite: false, thinkMode: true },
    ]
    const ctx = makeMockCtx(profiles)
    const { hookCalls } = ctx
    await mountThinkMode(ctx, profiles)

    const hookCall = hookCalls.find((h) => h.name === "context")
    expect(hookCall).toBeDefined()

    const input = {
      sessionID: "test-session",
      agent: "unknown-agent",
      model: { providerID: "anthropic", id: "claude-sonnet-4-20250514" },
      system: [],
      messages: [],
      options: {} as Record<string, unknown>,
    }
    hookCall?.callback(input)

    expect(input.options.providerOptions).toBeUndefined()
  })

  test("does not register hook when no profiles have thinkMode", async () => {
    const profiles: ProfileConfig[] = [{ id: "hephaestus", mode: "subagent", allowWrite: false }]
    const ctx = makeMockCtx(profiles)
    const { hookCalls } = ctx
    const dispose = await mountThinkMode(ctx, profiles)

    expect(hookCalls.length).toBe(0)
    await dispose()
  })

  test("preserves existing providerOptions when injecting thinking", async () => {
    const profiles: ProfileConfig[] = [
      { id: "hephaestus", mode: "subagent", allowWrite: false, thinkMode: true },
    ]
    const ctx = makeMockCtx(profiles)
    const { hookCalls } = ctx
    await mountThinkMode(ctx, profiles)

    const hookCall = hookCalls.find((h) => h.name === "context")
    expect(hookCall).toBeDefined()

    const input = {
      sessionID: "test-session",
      agent: "hephaestus",
      model: { providerID: "anthropic", id: "claude-sonnet-4-20250514" },
      system: [],
      messages: [],
      options: { providerOptions: { temperature: 0.7 } } as Record<string, unknown>,
    }
    hookCall?.callback(input)

    const providerOptions = input.options.providerOptions as Record<string, unknown>
    expect(providerOptions.thinking).toEqual({ type: "enabled", budgetTokens: 4096 })
    expect(providerOptions.temperature).toBe(0.7)
  })

  test("uses default budget of 4096 tokens", async () => {
    const profiles: ProfileConfig[] = [
      { id: "test-agent", mode: "subagent", allowWrite: false, thinkMode: true },
    ]
    const ctx = makeMockCtx(profiles)
    const { hookCalls } = ctx
    await mountThinkMode(ctx, profiles)

    const hookCall = hookCalls.find((h) => h.name === "context")
    const input = {
      sessionID: "test-session",
      agent: "test-agent",
      model: { providerID: "anthropic", id: "claude-opus-4-20250514" },
      system: [],
      messages: [],
      options: {} as Record<string, unknown>,
    }
    hookCall?.callback(input)

    const thinking = (input.options.providerOptions as Record<string, unknown>).thinking as {
      type: string
      budgetTokens: number
    }
    expect(thinking.type).toBe("enabled")
    expect(thinking.budgetTokens).toBe(4096)
  })

  test("handles multiple profiles with mixed thinkMode settings", async () => {
    const profiles: ProfileConfig[] = [
      { id: "thinker", mode: "subagent", allowWrite: false, thinkMode: true },
      { id: "non-thinker", mode: "subagent", allowWrite: false, thinkMode: false },
      { id: "default", mode: "primary", allowWrite: true },
    ]
    const ctx = makeMockCtx(profiles)
    const { hookCalls } = ctx
    await mountThinkMode(ctx, profiles)

    const hookCall = hookCalls.find((h) => h.name === "context")
    expect(hookCall).toBeDefined()

    // thinker agent should get thinking config
    const inputThinker = {
      sessionID: "test-session",
      agent: "thinker",
      model: { providerID: "anthropic", id: "claude-sonnet-4-20250514" },
      system: [],
      messages: [],
      options: {} as Record<string, unknown>,
    }
    hookCall?.callback(inputThinker)
    expect(
      (inputThinker.options.providerOptions as Record<string, unknown>)?.thinking,
    ).toBeDefined()

    // non-thinker agent should not get thinking config
    const inputNonThinker = {
      sessionID: "test-session",
      agent: "non-thinker",
      model: { providerID: "anthropic", id: "claude-sonnet-4-20250514" },
      system: [],
      messages: [],
      options: {} as Record<string, unknown>,
    }
    hookCall?.callback(inputNonThinker)
    expect(inputNonThinker.options.providerOptions).toBeUndefined()

    // default agent (no thinkMode) should not get thinking config
    const inputDefault = {
      sessionID: "test-session",
      agent: "default",
      model: { providerID: "anthropic", id: "claude-sonnet-4-20250514" },
      system: [],
      messages: [],
      options: {} as Record<string, unknown>,
    }
    hookCall?.callback(inputDefault)
    expect(inputDefault.options.providerOptions).toBeUndefined()
  })
})
