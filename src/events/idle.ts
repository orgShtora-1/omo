/**
 * Idle-signal detection for the host event stream.
 *
 * The managed host (opencode 2.0.24) was observed live to deliver no
 * `session.idle` events to plugins, while the SDK also publishes
 * `session.status` events whose `data.status.type` becomes `"idle"` when a
 * session stops working. Both shapes therefore mean the same thing here, and
 * this module is the single place that decides "is this event telling me a
 * session went idle, and for which session".
 *
 * Pure and dependency-free on purpose: both the teams wake loop and the goal
 * continuation loop import it, so it must never pull in store or host state.
 */

export interface IdleSignal {
  sessionID: string
}

/**
 * Extract the idle signal from an unknown host event.
 *
 * Returns `{ sessionID }` when the event is either
 *
 * - `{ type: "session.idle", data: { sessionID } }`, or
 * - `{ type: "session.status", data: { sessionID, status: { type: "idle" } } }`,
 *
 * and `data.sessionID` is a non-empty (after trim) string. Returns `undefined`
 * for every other shape: wrong event type, a `session.status` event whose
 * status is `"retry"` or anything else, missing `data`, or a missing, empty or
 * non-string sessionID. Only defensive casts are used; the event is untrusted
 * host input and is never assumed to match its declared shape.
 */
export function idleSignalFrom(event: unknown): IdleSignal | undefined {
  if (typeof event !== "object" || event === null) return undefined
  const record = event as { type?: unknown; data?: unknown }
  const data = record.data
  if (typeof data !== "object" || data === null) return undefined
  const sessionID = (data as { sessionID?: unknown }).sessionID
  if (typeof sessionID !== "string" || !sessionID.trim()) return undefined
  if (record.type === "session.idle") return { sessionID }
  if (record.type === "session.status") {
    const status = (data as { status?: unknown }).status
    if (typeof status !== "object" || status === null) return undefined
    if ((status as { type?: unknown }).type === "idle") return { sessionID }
  }
  return undefined
}
