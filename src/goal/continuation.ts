import type { Goal, GoalStore, UsageSnapshot } from "./store"

/**
 * Bound on automatic idle re-injections per arming: after this many
 * continuations without completion the goal auto-pauses instead of prompting
 * again. `set` (a new objective, which a breached or cancelled goal refuses) and
 * `resume` re-arm the budget. The model can also always exit early via
 * `update_goal` with `paused` or `complete`.
 */
export const MAX_CONTINUATIONS = 5

export type ContinuationOutcome = { continued: true; sessionID: string } | { continued: false }

type HostEvent = {
  type?: string
  data?: {
    sessionID?: string
    cost?: unknown
    tokens?: {
      input?: unknown
      output?: unknown
      reasoning?: unknown
      cache?: { read?: unknown; write?: unknown } | null
    } | null
  } | null
}

function buildContinuationPrompt(goal: Goal, round: number, max: number): string {
  return (
    `[omo goal] The session is idle with an active goal (continuation ${round}/${max}): ` +
    `"${goal.objective}". Continue working toward the objective, or call update_goal ` +
    `with status "complete" if it is achieved. If no further progress is possible, ` +
    `call update_goal with status "paused".`
  )
}

/**
 * The V2 host publishes the session's cumulative totals on every usage update,
 * so a report is a snapshot rather than a delta. A report without any cache
 * counter is still a valid snapshot: its cache usage is zero, and it is charged
 * like any other report. A *partially* reported cache object is refused, since
 * it would understate cache usage without saying so.
 */
function isSnapshot(data: NonNullable<HostEvent["data"]>): data is {
  sessionID: string
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
} {
  const cache = data.tokens?.cache
  return (
    typeof data.sessionID === "string" &&
    typeof data.cost === "number" &&
    !!data.tokens &&
    typeof data.tokens.input === "number" &&
    typeof data.tokens.output === "number" &&
    typeof data.tokens.reasoning === "number" &&
    (cache === undefined ||
      cache === null ||
      (typeof cache.read === "number" && typeof cache.write === "number"))
  )
}

function cacheCounters(data: NonNullable<HostEvent["data"]>): { read: number; write: number } {
  const cache = data.tokens?.cache
  return {
    read: typeof cache?.read === "number" ? cache.read : 0,
    write: typeof cache?.write === "number" ? cache.write : 0,
  }
}

/**
 * Drive one host event against the goal store. Idle sessions with an active
 * goal get the objective re-injected (bounded); usage reports are accrued.
 * The event stream is advisory: malformed payloads and failed prompts resolve
 * to `{ continued: false }` instead of throwing.
 *
 * Scoping a host event to this plugin's project and location is the caller's
 * job (see `mountGoalContinuation` in ./tools.ts). Here a session id is simply
 * looked up in this store, which is already per-project and per-session.
 */
export function createGoalContinuation(deps: {
  store: GoalStore
  prompt(sessionID: string, text: string): Promise<unknown>
  /**
   * Optional model-facing summary of the session's current work. Best-effort:
   * a throwing or absent summary is omitted rather than failing the prompt.
   */
  work?(sessionID: string): string | null
  maxContinuations?: number
}) {
  const max = deps.maxContinuations ?? MAX_CONTINUATIONS
  if (!Number.isSafeInteger(max) || max < 1) throw new Error("invalid-continuation-limit")
  const pending = new Set<string>()
  return {
    async handleEvent(event: { type?: unknown; data?: unknown }): Promise<ContinuationOutcome> {
      try {
        const type = typeof event.type === "string" ? event.type : ""
        const data = (event.data ?? {}) as NonNullable<HostEvent["data"]>
        const sessionID = data.sessionID
        if (typeof sessionID !== "string" || !sessionID) return { continued: false }
        if (type === "session.usage.updated") {
          if (isSnapshot(data)) {
            const usage: UsageSnapshot = {
              cost: data.cost,
              tokens: {
                input: data.tokens.input,
                output: data.tokens.output,
                reasoning: data.tokens.reasoning,
                cache: cacheCounters(data),
              },
            }
            deps.store.accrueSnapshot(sessionID, usage)
          }
          return { continued: false }
        }
        if (type !== "session.idle") return { continued: false }
        if (pending.has(sessionID)) return { continued: false }
        const goal = deps.store.get(sessionID)
        if (goal?.status !== "active") return { continued: false }
        if (goal.continuationPending) {
          deps.store.pause(sessionID)
          return { continued: false }
        }
        if (goal.continuations >= max) {
          deps.store.pause(sessionID)
          return { continued: false }
        }
        // Persist the reservation before admission: a rejected promise does not
        // prove that the host failed to admit the prompt. Never retry blindly.
        const reservation = deps.store.noteContinuation(sessionID)
        if (!reservation?.continuationID) return { continued: false }
        pending.add(sessionID)
        let context = ""
        try {
          const summary = deps.work?.(sessionID)
          if (typeof summary === "string" && summary.trim()) context = `\n\n${summary.trim()}`
        } catch {
          context = ""
        }
        try {
          await deps.prompt(
            sessionID,
            buildContinuationPrompt(goal, goal.continuations + 1, max) + context,
          )
          deps.store.finishContinuation(sessionID, reservation.continuationID)
          return { continued: true, sessionID }
        } catch {
          deps.store.finishContinuation(sessionID, reservation.continuationID, true)
          return { continued: false }
        } finally {
          pending.delete(sessionID)
        }
      } catch {
        return { continued: false }
      }
    },
  }
}
