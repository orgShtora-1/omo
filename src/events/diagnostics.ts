/**
 * Observability for the idle-wake and goal-continuation event loops.
 *
 * Both loops treat the host event stream as advisory and swallow per-event
 * failures so a bad event never kills the loop. That is the right resilience
 * policy, but it made the live failure invisible: three probe rounds on the
 * managed host observed zero wake prompts with no recorded reason. These
 * counters keep the resilience policy unchanged while making the loop's
 * behaviour — and its failures — observable from the read-only doctor surface.
 *
 * The class is pure in-process state with no host or store dependencies, so
 * the module also exports one shared singleton for the loops to record into
 * and the doctor to read from.
 */

/** Number of error messages retained; older ones are dropped. */
const ERROR_RING_SIZE = 5

/** Longest error message kept; longer messages are truncated. */
const ERROR_MESSAGE_LIMIT = 200

/** Distinct event type names retained; further names are not counted. */
const MAX_SHAPE_KEYS = 100

export interface EventDiagnosticsSnapshot {
  readonly seen: number
  readonly idleSignals: number
  readonly wakeAttempts: number
  readonly prompts: number
  readonly quietTicks: number
  readonly errorCount: number
  readonly lastErrors: readonly string[]
  readonly lastError: string | null
  readonly shapes: Readonly<Record<string, number>>
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export class EventDiagnostics {
  private seen = 0
  private idleSignals = 0
  private wakeAttempts = 0
  private prompts = 0
  private quietTicks = 0
  private errorCount = 0
  private readonly ring: string[] = []
  private lastError: string | null = null
  private readonly shapeCounts = new Map<string, number>()
  private lastActivityAt: number | undefined
  private readonly sessionActivity = new Map<string, number>()

  /** One host event reached a subscribed loop. */
  recordSeen(): void {
    this.seen += 1
  }

  /**
   * Note event-stream activity so the quiet-window prompter can tell an idle
   * session from a busy one. Kept out of the snapshot on purpose: it is a
   * live timestamp, not a counter.
   */
  noteActivity(at: number = Date.now()): void {
    this.lastActivityAt = at
  }

  /** Milliseconds of the last observed event, if any. */
  lastActivity(): number | undefined {
    return this.lastActivityAt
  }

  /** Milliseconds of the last observed event for one session, if any. */
  lastActivityFor(sessionID: string): number | undefined {
    return this.sessionActivity.get(sessionID)
  }

  /**
   * Note activity only when the event carries a session id and represents real
   * work. Background broadcasts (config, plugin, mcp or provider updates with
   * no session) must not keep the quiet-window prompter from ever seeing an
   * idle gap, and session-scoped heartbeats (status, usage) are not work
   * either — a continued session emits them while it sits idle. The per-session
   * timestamp lets a mount judge only its own sessions, so unrelated traffic
   * cannot hold the quiet window open.
   */
  noteActivityFrom(event: unknown): void {
    const record = event as { type?: unknown; data?: unknown } | null | undefined
    const data = record?.data
    if (typeof data !== "object" || data === null) return
    const sessionID = (data as { sessionID?: unknown }).sessionID
    if (typeof sessionID !== "string" || sessionID.trim() === "") return
    if (record?.type === "session.status" || record?.type === "session.usage.updated") return
    this.sessionActivity.set(sessionID, Date.now())
    this.noteActivity()
  }

  /**
   * Count one observed event type name so the doctor can report which shapes
   * the host actually emits. Non-string names are ignored and distinct keys
   * are capped so the snapshot cannot grow without bound.
   */
  recordShape(typeName: unknown): void {
    if (typeof typeName !== "string" || typeName.length === 0) return
    const known = this.shapeCounts.get(typeName)
    if (known !== undefined) {
      this.shapeCounts.set(typeName, known + 1)
      return
    }
    if (this.shapeCounts.size >= MAX_SHAPE_KEYS) return
    this.shapeCounts.set(typeName, 1)
  }

  /**
   * Count one session.status value under a composite key so the doctor can
   * report which status values the host actually emits. Events that are not
   * session.status are ignored; a missing or non-string value lands in one
   * shared bucket. Composite keys share the recordShape cap.
   */
  recordStatusValue(event: unknown): void {
    if (typeof event !== "object" || event === null) return
    const { type, data } = event as { type?: unknown; data?: unknown }
    if (type !== "session.status") return
    const status =
      typeof data === "object" && data !== null ? (data as { status?: unknown }).status : undefined
    const value =
      typeof status === "object" && status !== null
        ? (status as { type?: unknown }).type
        : undefined
    this.recordShape(
      typeof value === "string" && value.length > 0
        ? `session.status:${value}`
        : "session.status:<missing>",
    )
  }

  /** One event carried a usable idle signal (session.idle or session.status idle). */
  recordIdle(): void {
    this.idleSignals += 1
  }

  /** One idle signal started wake decision work. */
  recordWakeAttempt(): void {
    this.wakeAttempts += 1
  }

  /** One wake prompt was accepted by the host. */
  recordPrompt(): void {
    this.prompts += 1
  }

  /** One quiet-window evaluation ran, whether or not it fired. */
  recordQuietTick(): void {
    this.quietTicks += 1
  }

  /** Record a swallowed failure; keeps the last five messages, truncated. */
  recordError(error: unknown): void {
    const message = errorMessage(error)
    const truncated =
      message.length > ERROR_MESSAGE_LIMIT ? message.slice(0, ERROR_MESSAGE_LIMIT) : message
    this.errorCount += 1
    this.ring.push(truncated)
    while (this.ring.length > ERROR_RING_SIZE) this.ring.shift()
    this.lastError = truncated
  }

  snapshot(): EventDiagnosticsSnapshot {
    return {
      seen: this.seen,
      idleSignals: this.idleSignals,
      wakeAttempts: this.wakeAttempts,
      prompts: this.prompts,
      quietTicks: this.quietTicks,
      errorCount: this.errorCount,
      lastErrors: [...this.ring],
      lastError: this.lastError,
      shapes: Object.fromEntries(this.shapeCounts),
    }
  }
}

/** Shared instance the event loops record into and the doctor reports from. */
export const eventDiagnostics = new EventDiagnostics()
