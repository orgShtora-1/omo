import type { RunEvent } from "../contracts.js"

// Structural subset of the public V2 event envelope; unrelated host events
// may be passed through this seam and are ignored.
export type HostRunEvent = {
  id: string
  type: string
  data: { sessionID?: string }
  durable?: { seq: number }
}

export function createRunEventTracker() {
  const attempts = new Map<
    string,
    { attemptID: string; sequence: number; terminal: boolean; seen: Set<string> }
  >()
  return {
    track(sessionID: string, attemptID: string, afterSequence = 0): void {
      const previous = attempts.get(sessionID)
      attempts.set(sessionID, {
        attemptID,
        sequence: Math.max(afterSequence, previous?.sequence ?? 0),
        terminal: false,
        seen: new Set(),
      })
    },
    accept(event: HostRunEvent): RunEvent | undefined {
      const sessionID = event.data.sessionID
      if (!sessionID) return
      const attempt = attempts.get(sessionID)
      if (!attempt) return
      const state = {
        "session.execution.started": "running",
        "session.execution.succeeded": "completed",
        "session.execution.failed": "failed",
        "session.execution.interrupted": "cancelled",
      }[event.type] as RunEvent["state"] | undefined
      if (!state) return
      const sequence = event.durable?.seq
      if (sequence === undefined || sequence <= attempt.sequence || attempt.seen.has(event.id))
        return
      attempt.sequence = sequence
      if (attempt.terminal) return
      attempt.seen.add(event.id)
      attempt.terminal = state !== "running"
      return { attemptID: attempt.attemptID, sessionID, state, eventID: event.id }
    },
  }
}

export type RunEventTracker = ReturnType<typeof createRunEventTracker>

// One subscription owner awaits `done` and reconciles inspect() after a
// disconnect. The public event stream is live-only, not a recovery log.
export function subscribeRunEvents(
  host: { subscribe(input: { signal: AbortSignal }): AsyncIterable<HostRunEvent> },
  tracker: RunEventTracker,
  deliver: (event: RunEvent) => Promise<void>,
) {
  const controller = new AbortController()
  const done = (async () => {
    try {
      for await (const event of host.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) break
        const normalized = tracker.accept(event)
        if (normalized) await deliver(normalized)
      }
    } catch (error) {
      if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") return
      throw error
    }
  })()
  return { done, dispose: () => controller.abort() }
}
