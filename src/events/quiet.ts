/**
 * Quiet-window prompter.
 *
 * The host never delivers an idle signal for continued or child sessions
 * (each spawned agent runs on an isolated event bus), so the event loops can
 * wait forever for a trigger that cannot arrive. This prompter is the only
 * trigger that works under that architecture: it watches the shared event
 * stream as an activity oracle and fires the mount's quiet handler once the
 * stream has been silent past the window.
 *
 * The prompter itself stays dumb on purpose: spam protection (one-shot per
 * message id, wake budgets) lives in the mount's decision code, which the
 * quiet handler reuses unchanged.
 */
export interface QuietPrompterOptions {
  signal: AbortSignal
  intervalMs?: number
  quietMs?: number
  now?: () => number
  /** Stream-silence oracle. Optional when `shouldFire` decides instead. */
  lastActivity?: () => number | undefined
  onQuiet: () => Promise<void>
  /** Runs on every tick, even when the stream is busy or the window is open. */
  onTick?: () => void
  /**
   * Optional replacement for the stream-silence check. A mount whose host never
   * reports an idle session (the managed host does not) gates on pending work
   * instead: it fires whenever it still has sessions to check, and the mount's
   * own decision code keeps one-shot hints and wake budgets in force.
   */
  shouldFire?: () => boolean
}

/**
 * Start the interval. Returns a stop function that clears the interval and
 * waits for an in-flight tick. Ticks never overlap: a slow onQuiet simply
 * skips the ticks that would have fired while it runs.
 */
export function startQuietPrompter(options: QuietPrompterOptions): () => Promise<void> {
  const {
    signal,
    intervalMs = 15_000,
    quietMs = 120_000,
    now = Date.now,
    lastActivity,
    onQuiet,
    onTick,
    shouldFire,
  } = options
  let stopped = false
  let inFlight: Promise<void> | null = null
  const id = setInterval(() => {
    onTick?.()
    if (stopped || signal.aborted || inFlight !== null) return
    if (shouldFire) {
      if (!shouldFire()) return
    } else {
      const last = lastActivity?.()
      if (last === undefined || now() - last < quietMs) return
    }
    inFlight = onQuiet()
      .catch(() => {
        // Backstop only: the mount records per-session errors itself.
      })
      .finally(() => {
        inFlight = null
      })
  }, intervalMs)
  return async () => {
    stopped = true
    clearInterval(id)
    await inFlight
  }
}
