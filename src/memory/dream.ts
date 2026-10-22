/**
 * The dream/time reflection trigger.
 *
 * A dream is a reflection the agent queues on its own initiative after the
 * session went quiet — no compaction decided it and no step observed new text.
 * Because nothing here spawns model work (the queue stays agent-driven), the
 * whole feature reduces to one honest question the storage can answer: has an
 * idle gap been observed since the last dream, and has the cadence elapsed?
 *
 * Two rules, both pure:
 *  - `dreamIdleDue` arms the trigger from the PREVIOUS activity timestamp. The
 *    request that returns to an idle session is itself activity, so the gap must
 *    be measured before the observation moves the clock.
 *  - `dreamVerdict` refuses unless the gap was armed, and refuses a second
 *    dream inside `minHoursBetween`.
 *
 * Reasons are exact strings: `disabled`, `no-idle-gap`, `too-soon`. Callers
 * surface them verbatim; a refusal never becomes a silent skip.
 */

export type DreamConfig = {
  enabled: boolean
  /** Minutes without observation that arm a dream. Positive integer. */
  idleMinutes: number
  /** Hours that must elapse between two queued dreams. Positive integer. */
  minHoursBetween: number
}

/** Persisted dream bookkeeping, stored alongside the queue state. */
export type DreamState = {
  activityAt?: number
  dreamAt?: number
  dreamDue?: boolean
}

export type DreamVerdict =
  | { due: true }
  | { due: false; reason: "disabled" | "no-idle-gap" | "too-soon" }

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  enabled: true,
  idleMinutes: 30,
  minHoursBetween: 24,
}

const DREAM_KEYS = new Set(["enabled", "idleMinutes", "minHoursBetween"])

/**
 * True when the gap between the previous activity and `now` reached the idle
 * window. Measuring against the previous timestamp (not the new one) is what
 * lets the return-to-session observation arm the trigger it is about to close.
 */
export function dreamIdleDue(
  config: DreamConfig,
  previousActivityAt: number | undefined,
  now: number,
): boolean {
  if (!config.enabled) return false
  if (previousActivityAt === undefined || !Number.isSafeInteger(previousActivityAt)) return false
  return now - previousActivityAt >= config.idleMinutes * 60_000
}

/** Decides whether a dream snapshot may be queued right now. */
export function dreamVerdict(config: DreamConfig, state: DreamState, now: number): DreamVerdict {
  if (!config.enabled) return { due: false, reason: "disabled" }
  if (state.dreamDue !== true) return { due: false, reason: "no-idle-gap" }
  if (state.dreamAt !== undefined && now - state.dreamAt < config.minHoursBetween * 3_600_000)
    return { due: false, reason: "too-soon" }
  return { due: true }
}

/**
 * Normalizes configuration coming from the options schema (or a test) into a
 * complete DreamConfig. Anything malformed fails closed: a dream policy that
 * half-parsed would silently disable or over-enable the trigger.
 */
export function validateDreamConfig(input: unknown): DreamConfig {
  if (input === undefined) return { ...DEFAULT_DREAM_CONFIG }
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("invalid-dream-config")
  const record = input as Record<string, unknown>
  for (const key of Object.keys(record))
    if (!DREAM_KEYS.has(key)) throw new Error("invalid-dream-config")
  const enabled = record.enabled
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("invalid-dream-config")
  const positive = (value: unknown) =>
    value === undefined || (Number.isSafeInteger(value) && (value as number) >= 1)
  if (!positive(record.idleMinutes) || !positive(record.minHoursBetween))
    throw new Error("invalid-dream-config")
  return {
    enabled: enabled === undefined ? DEFAULT_DREAM_CONFIG.enabled : enabled,
    idleMinutes:
      record.idleMinutes === undefined
        ? DEFAULT_DREAM_CONFIG.idleMinutes
        : (record.idleMinutes as number),
    minHoursBetween:
      record.minHoursBetween === undefined
        ? DEFAULT_DREAM_CONFIG.minHoursBetween
        : (record.minHoursBetween as number),
  }
}
