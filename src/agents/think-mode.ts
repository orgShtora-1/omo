import type { Plugin } from "@opencode/plugin"
import type { ProfileConfig } from "../config/schema"

// Extended Thinking Mode — P2-T3. When a profile has `thinkMode: true`, this
// hook injects Anthropic-style thinking configuration into the generation
// options so that models supporting extended reasoning (Claude, etc.) allocate
// a thinking budget for the request. The configuration is passed through
// `providerOptions.thinking` which is accepted by the Anthropic provider and
// ignored (pass-through) by providers that don't recognize it.
//
// Default thinking budget: 4096 tokens. Can be overridden per-profile via
// `thinkBudget` if needed; this implementation uses the fixed default to keep
// the schema simple.
const DEFAULT_THINKING_BUDGET = 4096

/** Per-profile thinking configuration injected into generation options. */
type ThinkingConfig = {
  type: "enabled"
  budgetTokens: number
}

/**
 * Register extended thinking mode for profiles that opt in via `thinkMode`.
 * Fires once per model context build (before each LLM call). When the agent
 * matches a profile with `thinkMode: true`, the thinking config is added to
 * `input.options.providerOptions.thinking`.
 *
 * Only injects when the profile explicitly enables thinking — does not modify
 * behavior for profiles without `thinkMode`.
 */
export async function mountThinkMode(
  ctx: Plugin.Context,
  profiles: ProfileConfig[],
): Promise<() => Promise<void>> {
  // Build a lookup from profile id to think config.
  const thinkConfigByProfile = new Map<string, ThinkingConfig>()
  for (const profile of profiles) {
    if (profile.thinkMode) {
      thinkConfigByProfile.set(profile.id, {
        type: "enabled",
        budgetTokens: DEFAULT_THINKING_BUDGET,
      })
    }
  }
  if (thinkConfigByProfile.size === 0) return async () => {}

  const registration = await ctx.session.hook("context", async (input) => {
    const config = thinkConfigByProfile.get(input.agent)
    if (!config) return
    // Inject into providerOptions; safe pass-through for non-Anthropic providers.
    const providerOptions = (input.options.providerOptions ?? {}) as Record<string, unknown>
    providerOptions.thinking = config
    input.options.providerOptions = providerOptions
  })

  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    await registration.dispose()
  }
}
