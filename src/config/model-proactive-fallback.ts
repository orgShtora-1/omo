import type { Plugin } from "@opencode/plugin"
import type { ModelRef } from "../contracts"
import type { FallbackPolicy } from "./model-fallback"
import { fallbackCandidatePermitted } from "./model-fallback"

// Proactive (context-size-based) model fallback — complement to the reactive
// `session.hook("retry")` fallback. This hook fires BEFORE each model request
// and measures the built context; if it exceeds `triggerPct` of the configured
// model limit, it switches to the next candidate in the profile chain so the
// next attempt lands inside the limit. Default off (no hook registered).

/** Fraction of the model limit that arms proactive switching. */
const DEFAULT_TRIGGER_PCT = 0.9
/** Minimum spacing between two proactive switches of one session. */
const DEFAULT_COOLDOWN_MS = 30_000

export type ProactiveModelFallbackConfig = {
  enabled: boolean
  /** Fraction of the model limit above which we switch proactively (0..1). */
  triggerPct: number
  /** Minimum ms between two proactive switches for the same session. */
  cooldownMs: number
}

export const DEFAULT_PROACTIVE_MODEL_FALLBACK: ProactiveModelFallbackConfig = {
  enabled: false,
  triggerPct: DEFAULT_TRIGGER_PCT,
  cooldownMs: DEFAULT_COOLDOWN_MS,
}

/** Per-session loop guard: one proactive switch at a time plus a cooldown. */
type ProactiveSessionState = {
  inflight: boolean
  lastAt: number | undefined
}

/**
 * Estimate token count from context text. Rough heuristic: ~4 chars per token
 * for English, ~2 for CJK. Used only as a threshold trigger; exact counts are
 * irrelevant because the host owns the real tokenizer.
 */
function estimateTokens(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  // Heuristic: CJK-heavy text compresses more densely; fall back to byte/4.
  const avgBytesPerToken = 4
  return Math.max(1, Math.ceil(bytes / avgBytesPerToken))
}

function countContextTokens(
  system: Array<{ type: string; text: string }>,
  messages: unknown[],
): number {
  let total = 0
  for (const part of system) total += estimateTokens(part.text)
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue
      const m = msg as Record<string, unknown>
      const content = m.content
      if (typeof content === "string") total += estimateTokens(content)
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (
            part &&
            typeof part === "object" &&
            typeof (part as Record<string, unknown>).text === "string"
          )
            total += estimateTokens((part as Record<string, unknown>).text as string)
        }
      }
    }
  }
  return total
}

function sameRef(a: ModelRef, b: ModelRef): boolean {
  return a.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant
}

/**
 * Proactive decision: given the current context and the model's limit, decide
 * whether to switch to the next candidate in the profile chain. Mirrors
 * `fallbackDecision` shape so callers can reuse the same chain.
 */
export function proactiveVerdict(
  config: ProactiveModelFallbackConfig,
  policy: FallbackPolicy,
  profileID: string,
  model: ModelRef,
  contextTokens: number,
  modelLimit: number,
  chain: ModelRef[],
  now: number,
  state: ProactiveSessionState,
): { switch?: ModelRef; delayMs?: number } {
  if (!config.enabled) return {}
  if (state.inflight) return {}
  if (!chain || chain.length === 0) return {}
  if (modelLimit === 0 || modelLimit === Infinity) return {}
  const threshold = modelLimit * config.triggerPct
  if (contextTokens < threshold) return {}
  if (state.lastAt !== undefined && now - state.lastAt < config.cooldownMs) return {}
  // Find the current model's position and the next candidate.
  const failedAt = chain.findIndex((c) => sameRef(c, model))
  for (let idx = failedAt + 1; idx < chain.length; idx++) {
    const candidate = chain[idx]
    if (!candidate) continue
    if (!fallbackCandidatePermitted(policy, profileID, candidate)) continue
    return { switch: candidate, delayMs: config.cooldownMs }
  }
  return {}
}

/**
 * Register proactive model fallback via `session.hook("context")`. Fires once
 * per model request (each agent loop turn) before the LLM call. When the
 * estimated context exceeds `triggerPct` of the model's configured limit, the
 * next candidate in the profile chain is switched in via `switchModel`.
 *
 * The reactive `session.hook("retry")` fallback remains the primary safety net;
 * this hook only moves the switch earlier when context is about to overflow.
 * Both hooks are composable: if the reactive fallback also fires, it operates
 * on the already-swapped model (or the same one if nothing changed).
 */
export async function mountProactiveModelFallback(
  ctx: Plugin.Context,
  config: ProactiveModelFallbackConfig,
  policy: FallbackPolicy,
  profiles: Record<string, ModelRef[]>,
  modelLimits: Record<string, number>,
): Promise<() => Promise<void>> {
  if (!config.enabled) return async () => {}
  const guards = new Map<string, ProactiveSessionState>()
  const guardFor = (sessionID: string): ProactiveSessionState => {
    const existing = guards.get(sessionID)
    if (existing) return existing
    const state: ProactiveSessionState = { inflight: false, lastAt: undefined }
    guards.set(sessionID, state)
    return state
  }
  const registration = await ctx.session.hook("context", async (input) => {
    const model: ModelRef = {
      providerID: input.model.providerID,
      modelID: input.model.id,
      ...(input.model.variant ? { variant: input.model.variant } : {}),
    }
    // Find the profile for this agent (best-effort: fall back to first).
    const profileID = input.agent || Object.keys(profiles)[0] || ""
    const chain = profiles[profileID]
    if (!chain || chain.length === 0) return
    // Look up the model limit from the resolved options.
    const limitKey = `${model.providerID}/${model.modelID}`
    const limit = modelLimits[limitKey]
    if (limit === undefined || limit === 0) return
    const tokens = countContextTokens(input.system, input.messages)
    const state = guardFor(input.sessionID)
    const verdict = proactiveVerdict(
      config,
      policy,
      profileID,
      model,
      tokens,
      limit,
      chain,
      Date.now(),
      state,
    )
    if (!verdict.switch) return
    state.inflight = true
    state.lastAt = Date.now()
    try {
      await ctx.session.switchModel({
        sessionID: input.sessionID,
        model: {
          id: verdict.switch.modelID,
          providerID: verdict.switch.providerID,
          ...(verdict.switch.variant ? { variant: verdict.switch.variant } : {}),
        },
      })
    } catch {
      state.inflight = false
      return
    }
  })
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    guards.clear()
    await registration.dispose()
  }
}
