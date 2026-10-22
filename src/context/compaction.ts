import type { Plugin } from "@opencode/plugin"
import type { PlanRepository, Scope } from "../contracts"
import { assembleContext } from "./assembly"

const marker = "[omo recovery:"

/** Preemptive (threshold-based) compaction policy (option `preemptive_compaction`).
 * The context hook measures the context as built — recovery references included —
 * and asks the host to compact when it exceeds `thresholdChars`. Default off:
 * passive compaction handling stays the only behavior unless opted in. */
export type PreemptiveCompactionConfig = {
  enabled: boolean
  /** Built-context size in characters that arms a compaction request. */
  thresholdChars: number
  /** Minimum spacing between two preemptive compactions of one session. */
  cooldownMs: number
}

export const DEFAULT_PREEMPTIVE_COMPACTION: PreemptiveCompactionConfig = {
  enabled: false,
  thresholdChars: 120_000,
  cooldownMs: 60_000,
}

/** Per-session loop guard: one queued compaction at a time plus a cooldown
 * timestamp that every observed compaction cycle re-arms. */
export type PreemptiveSessionState = {
  /** A compaction queued by this hook whose cycle the compaction hook has not observed yet. */
  inflight: boolean
  /** When a compaction was last queued or observed for this session. */
  lastAt: number | undefined
}

/** Exact refusal reasons, in guard order: safety states are reported even
 * when the size alone would already refuse. */
export type PreemptiveVerdict =
  | { trigger: true }
  | { trigger: false; reason: "disabled" | "in-flight" | "below-threshold" | "cooldown" }

/** Pure decision: may this context build ask the host for a compaction right
 * now? The clock is injected through `now`, so the guard is testable without a
 * host. A compact-loop is impossible: an unobserved queued compaction refuses
 * every further request (in-flight), and within `cooldownMs` of the last
 * queued or observed compaction nothing may queue again. */
export function preemptiveVerdict(
  config: PreemptiveCompactionConfig,
  state: PreemptiveSessionState,
  size: number,
  now: number,
): PreemptiveVerdict {
  if (!config.enabled) return { trigger: false, reason: "disabled" }
  if (state.inflight) return { trigger: false, reason: "in-flight" }
  if (size <= config.thresholdChars) return { trigger: false, reason: "below-threshold" }
  if (state.lastAt !== undefined && now - state.lastAt < config.cooldownMs)
    return { trigger: false, reason: "cooldown" }
  return { trigger: true }
}

/** Optional knobs for `mountContext`: the preemptive policy and a clock. */
export type MountContextOptions = {
  preemptive?: PreemptiveCompactionConfig
  now?: () => number
}

/** Rehydrates current durable state at every generation, including after host compaction. */
export async function mountContext(
  ctx: Plugin.Context,
  repository: PlanRepository,
  scopeFor: (sessionID: string) => Promise<Scope>,
  maxChars = 12000,
  options: MountContextOptions = {},
): Promise<() => Promise<void>> {
  const preemptive = options.preemptive ?? DEFAULT_PREEMPTIVE_COMPACTION
  const now = options.now ?? Date.now
  const guards = new Map<string, PreemptiveSessionState>()
  const guardFor = (sessionID: string): PreemptiveSessionState => {
    const existing = guards.get(sessionID)
    if (existing) return existing
    const state: PreemptiveSessionState = { inflight: false, lastAt: undefined }
    guards.set(sessionID, state)
    return state
  }
  const inject = async (
    sessionID: string,
    system: { type: string; text: string }[],
  ): Promise<void> => {
    const plans = await repository.list(await scopeFor(sessionID))
    const packets: string[] = []
    let remaining = maxChars
    for (const plan of plans) {
      const step =
        plan.steps.find((item) => item.state === "running" || item.state === "verifying") ??
        plan.steps.find(
          (item) =>
            item.state === "pending" &&
            item.dependencies.every((id) =>
              plan.steps.some(
                (dependency) => dependency.id === id && dependency.state === "completed",
              ),
            ),
        )
      if (!step) continue
      const packet = assembleContext(plan, step.id, { maxChars: remaining })
      packets.push(packet.text)
      remaining -= packet.text.length + 2
    }
    const kept = system.filter((part) => !part.text.startsWith(marker))
    system.length = 0
    system.push(...kept)
    if (packets.length) system.push({ type: "text", text: packets.join("\n\n") })
  }
  const maybeCompact = async (
    sessionID: string,
    system: { type: string; text: string }[],
  ): Promise<void> => {
    if (!preemptive.enabled) return
    const size = system.reduce((total, part) => total + part.text.length, 0)
    const state = guardFor(sessionID)
    const verdict = preemptiveVerdict(preemptive, state, size, now())
    if (!verdict.trigger) return
    state.inflight = true
    state.lastAt = now()
    try {
      // SessionDomain.compact queues a host compaction request for the session.
      await ctx.session.compact({ sessionID })
    } catch {
      // A compaction that never queued leaves nothing for the compaction hook
      // to observe: release the in-flight mark so the cooldown armed at queue
      // time is the only remaining rate limit. The request that built this
      // context must not fail because the auxiliary channel did.
      state.inflight = false
    }
  }
  const contextRegistration = await ctx.session.hook("context", async (input) => {
    await inject(input.sessionID, input.system)
    // Preemptive compaction measures the context as built (after recovery
    // injection) and queues at most one host compaction per cooldown window.
    await maybeCompact(input.sessionID, input.system)
  })
  const compactionRegistration = await ctx.session.hook("compaction", async (input) => {
    // Every compaction cycle — ours, the user's or the host's — is observed
    // before any summary decision: the guard must see cycles even when another
    // hook already owns the result, and a queued in-flight mark is released
    // exactly here, when the cycle is real.
    if (preemptive.enabled) {
      const state = guardFor(input.sessionID)
      state.inflight = false
      state.lastAt = now()
    }
    // A result owned by another hook means the summary is already decided; never override it.
    if (input.result !== undefined) return
    // Best-effort: foreign sessions compact without OmO refs instead of failing the host flow.
    try {
      await inject(input.sessionID, input.system)
    } catch {
      // Host summary proceeds without durable recovery references.
    }
  })
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    guards.clear()
    await contextRegistration.dispose()
    await compactionRegistration.dispose()
  }
}
