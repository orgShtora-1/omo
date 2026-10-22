import { type BoulderOptions, type BoulderStore, openBoulderStore } from "./store"

/**
 * Model-facing summary of a session's current work. A summary never throws: an
 * unreadable plan, corrupt record or absent work is simply no context, because
 * the continuation prompt must stay a best-effort hint.
 */
export interface BoulderContext {
  readonly store: BoulderStore
  summary(sessionID: string): string | null
}

const TERMINAL = new Set(["completed", "abandoned"])

/**
 * Open the model-facing work context. Session records live under
 * `<stateHome>/boulder`; plan documents resolve and confine against
 * `options.projectRoot` (the project) and fall back to the state home when
 * absent.
 */
export function openBoulderContext(stateHome: string, options?: BoulderOptions): BoulderContext {
  const store = openBoulderStore(stateHome, options)
  return {
    store,
    summary(sessionID: string): string | null {
      if (typeof sessionID !== "string" || !sessionID.trim()) return null
      try {
        const work = store.get(sessionID)
        if (!work || TERMINAL.has(work.status)) return null
        const progress = store.progress(sessionID, work.id)
        if (!progress) return null
        const next = progress.next
          ? ` next step: line ${progress.next.line} ${progress.next.label}`
          : " next step: none pending"
        return (
          `[omo work] ${work.status} work ${work.id} on ${work.plan}: ` +
          `${progress.completed}/${progress.total} tasks done, ${progress.remaining} remaining.${next}`
        )
      } catch {
        return null
      }
    },
  }
}
