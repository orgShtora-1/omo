import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type GoalStatus = "active" | "paused" | "complete" | "cancelled"

/** The budget a session owner sets for a goal; enforced on every usage report. */
export type GoalLimits = { maxCost?: number; maxTokens?: number }

/** The first limit that stopped the goal. Cost is reported before tokens. */
type LimitDimension = "cost" | "tokens"

export type Goal = {
  version: 1
  sessionID: string
  objective: string
  status: GoalStatus
  createdAt: string
  updatedAt: string
  tokensUsed: number
  /**
   * Seconds the goal has been active, settled whenever it leaves `active`. It is
   * written by `withStatus`; records that predate it read back as zero.
   */
  timeUsedSeconds: number
  /**
   * Clock reading (ms) that starts the current active interval. Present only
   * while `status` is `active`; a record pairing it with any other status is
   * treated as corrupt rather than repaired.
   */
  activeSince?: number
  /** Lifetime cost in USD accrued from `session.usage.updated` events. */
  costUsed: number
  /** Automatic idle re-injections since the last set/resume. */
  continuations: number
  /** Persisted before submission; unresolved admissions require explicit recovery. */
  continuationPending?: boolean
  continuationID?: string
  /** Last host-reported cumulative usage; the base for the next snapshot delta. */
  usageBaseline?: UsageSnapshot
  /** Optional user budget. Absent means no cost/token ceiling for this goal. */
  limits?: GoalLimits
  /** Set once usage crossed a limit; cleared only by writing a new objective. */
  limitExceeded?: LimitDimension
}

/**
 * A host usage report. The V2 host republishes the session's cumulative totals on
 * every `session.usage.updated` (see the pinned projector's `publishSessionUsage`,
 * which reads the projected session row), so this is a snapshot, never a delta.
 */
export type UsageSnapshot = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export type RecoveryDisposition = "retry" | "abandon"

export type GoalStore = {
  set(sessionID: string, objective: string, limits?: GoalLimits): Goal
  get(sessionID: string): Goal | null
  pause(sessionID: string): Goal | null
  resume(sessionID: string): Goal | null
  complete(sessionID: string): Goal | null
  /**
   * Terminal: once cancelled, a goal cannot be resumed, completed, re-paused,
   * re-armed with `set` nor opened to `paused` by an abandoned continuation.
   * Calling `cancel` again still returns the current record.
   */
  cancel(sessionID: string): Goal | null
  /**
   * Settle a continuation admission whose outcome is unknown (crash or restart
   * between submission and confirmation). `retry` keeps the goal as it is and
   * clears the reservation so a later idle event may continue; `abandon` also
   * pauses the goal. Neither reports an unresolved admission as settled: they
   * leave it pending for an explicit `recover`.
   */
  recoverContinuation(sessionID: string, disposition: RecoveryDisposition): Goal | null
  clear(sessionID: string): boolean
  /**
   * Account for one cumulative host usage report. The first report of a goal
   * only establishes the baseline; later reports add the increase. Reports that
   * fall below the baseline are treated as a new baseline (the host may reset),
   * never as a subtraction. null when no goal exists.
   */
  accrueSnapshot(sessionID: string, usage: UsageSnapshot): Goal | null
  /** Count one automatic idle continuation; null when no goal exists. */
  noteContinuation(sessionID: string): Goal | null
  finishContinuation(sessionID: string, admissionID: string, failed?: boolean): Goal | null
}

const MAX_OBJECTIVE_LENGTH = 2000

/**
 * The first limit this goal's lifetime usage has crossed, cost before tokens.
 * Pure so record validation and usage accrual agree on one definition.
 */
function breachedLimit(usage: {
  costUsed: number
  tokensUsed: number
  limits?: GoalLimits
}): LimitDimension | undefined {
  const { maxCost, maxTokens } = usage.limits ?? {}
  if (maxCost !== undefined && usage.costUsed > maxCost) return "cost"
  if (maxTokens !== undefined && usage.tokensUsed > maxTokens) return "tokens"
  return undefined
}

/**
 * Validate an optional user budget. An absent budget means no ceiling; a
 * present one must name at least one dimension with a finite positive number.
 * Unknown dimensions are refused so a typo cannot silently disable a limit.
 */
export function validateLimits(limits: unknown): GoalLimits | undefined {
  if (limits === undefined) return undefined
  if (typeof limits !== "object" || limits === null || Array.isArray(limits))
    throw new Error("invalid-limits: expected an object")
  const entries = Object.entries(limits as Record<string, unknown>)
  if (entries.length === 0) throw new Error("invalid-limits: at least one dimension")
  const parsed: GoalLimits = {}
  for (const [key, value] of entries) {
    if (key !== "maxCost" && key !== "maxTokens")
      throw new Error(`invalid-limits: unknown dimension ${key}`)
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      throw new Error(`invalid-limits: ${key} must be a finite positive number`)
    // Token counts are whole; a fractional ceiling could never be reasoned about.
    if (key === "maxTokens" && !Number.isSafeInteger(value))
      throw new Error("invalid-limits: maxTokens must be a positive integer")
    parsed[key] = value
  }
  return parsed
}

/** Goal records live one JSON file per session under `<stateHome>/goal/`. */
export function goalDirectory(stateHome: string): string {
  return join(stateHome, "goal")
}

/**
 * Trim and validate a goal objective: non-empty after trimming and at most
 * 2000 characters (same contract as the upstream goal feature).
 */
export function validateObjective(objective: string): string {
  const trimmed = objective.trim()
  if (!trimmed) throw new Error("objective must be a non-empty string")
  if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
    throw new Error(`objective must be at most ${MAX_OBJECTIVE_LENGTH} characters`)
  }
  return trimmed
}

/**
 * Open the per-session goal store. Each session gets its own JSON file under
 * `dir` (atomic tmp+rename writes); a missing or corrupt file reads as null so
 * a damaged record never crashes the host.
 */
export function openGoalStore(dir: string, options: { now?: () => number } = {}): GoalStore {
  mkdirSync(dir, { recursive: true })
  const fileFor = (sessionID: string) => join(dir, `${encodeURIComponent(sessionID)}.json`)
  // Active time is measured with an injectable clock so it is verified without
  // waiting; every timestamp below comes from the same clock.
  const clock = options.now ?? Date.now

  const read = (sessionID: string): Goal | null => {
    try {
      const parsed = JSON.parse(readFileSync(fileFor(sessionID), "utf8")) as Goal
      if (
        parsed?.version !== 1 ||
        typeof parsed.objective !== "string" ||
        parsed.sessionID !== sessionID
      ) {
        return null
      }
      if (!["active", "paused", "complete", "cancelled"].includes(parsed.status)) return null
      if (validateObjective(parsed.objective) !== parsed.objective) return null
      // Records written before usage accounting carry no counters; they read
      // back with zero defaults instead of failing as corrupt.
      for (const field of ["tokensUsed", "timeUsedSeconds", "costUsed", "continuations"] as const) {
        if (parsed[field] === undefined) parsed[field] = 0
        if (!Number.isFinite(parsed[field]) || parsed[field] < 0) return null
      }
      if (!Number.isSafeInteger(parsed.continuations)) return null
      // An active interval is only meaningful while the goal is active.
      if (parsed.activeSince !== undefined) {
        if (parsed.status !== "active") return null
        if (!Number.isFinite(parsed.activeSince) || parsed.activeSince <= 0) return null
      }
      if (
        parsed.continuationPending !== undefined &&
        typeof parsed.continuationPending !== "boolean"
      )
        return null
      if (parsed.usageBaseline !== undefined) {
        try {
          validSnapshot(parsed.usageBaseline)
        } catch {
          return null
        }
      }
      if (parsed.limits !== undefined) {
        try {
          parsed.limits = validateLimits(parsed.limits)
        } catch {
          return null
        }
      }
      if (
        parsed.limitExceeded !== undefined &&
        parsed.limitExceeded !== null &&
        !["cost", "tokens"].includes(parsed.limitExceeded)
      )
        return null
      // A recorded breach must still correspond to usage above that budget, so a
      // corrupted record can never hide behind a plausible-looking marker.
      if (parsed.limitExceeded !== undefined && parsed.limitExceeded !== null) {
        if (breachedLimit(parsed) !== parsed.limitExceeded) return null
      }
      return parsed
    } catch {
      return null
    }
  }

  function validSnapshot(usage: UsageSnapshot): void {
    if (!Number.isFinite(usage?.cost) || usage.cost < 0) throw new Error("invalid-usage: cost")
    for (const field of ["input", "output", "reasoning"] as const) {
      const value = usage.tokens?.[field]
      if (!Number.isFinite(value) || (value as number) < 0)
        throw new Error(`invalid-usage: tokens.${field}`)
    }
    const cache = usage.tokens?.cache
    for (const field of ["read", "write"] as const) {
      const value = cache?.[field]
      if (!Number.isFinite(value) || (value as number) < 0)
        throw new Error(`invalid-usage: tokens.cache.${field}`)
    }
  }

  const write = (goal: Goal): void => {
    const target = fileFor(goal.sessionID)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(goal, null, 2), "utf8")
    renameSync(tmp, target)
  }

  const setStatus = (sessionID: string, status: GoalStatus): Goal | null => {
    const current = read(sessionID)
    if (!current) return null
    if (current.status === "cancelled") throw new Error("cancelled goal is terminal")
    if (status === "active") {
      // Authorisation gates: `setStatus` refuses to activate a goal that a user
      // budget already paused, or one whose continuation outcome nobody
      // confirmed. `set` enforces the same two gates above.
      if (current.limitExceeded) throw new Error(`limit-exceeded: ${current.limitExceeded}`)
      if (current.continuationPending) throw new Error("unresolved-continuation")
    }
    // Resuming re-arms the continuation budget; pausing and completing keep it.
    const next = withStatus(current, status, {
      continuations: status === "active" ? 0 : current.continuations,
      continuationPending: false,
      continuationID: undefined,
    })
    write(next)
    return next
  }

  /**
   * Move a record to another status and settle the elapsed active interval.
   * Every status change goes through here, so `timeUsedSeconds` can never be a
   * field that is declared and displayed but never written.
   */
  const withStatus = (current: Goal, status: GoalStatus, extra?: Partial<Goal>): Goal => {
    const now = clock()
    const leavingActive = current.status === "active" && status !== "active"
    const settled =
      leavingActive && typeof current.activeSince === "number"
        ? Math.max(0, Math.floor((now - current.activeSince) / 1000))
        : 0
    return {
      ...current,
      ...extra,
      status,
      updatedAt: new Date(now).toISOString(),
      timeUsedSeconds: current.timeUsedSeconds + settled,
      activeSince: status === "active" ? now : undefined,
    }
  }

  /** Apply a budget after usage changed: pausing is the only automatic stop. */
  const enforce = (goal: Goal): Goal => {
    const exceeded = breachedLimit(goal)
    if (!exceeded || goal.status !== "active") {
      return goal.limitExceeded ? { ...goal, limitExceeded: exceeded } : goal
    }
    return withStatus(goal, "paused", { limitExceeded: exceeded })
  }

  return {
    set(sessionID, objective, limits) {
      const trimmed = validateObjective(objective)
      const parsedLimits = validateLimits(limits)
      const now = clock()
      const existing = read(sessionID)
      // Only `clear` may remove these states: rewriting the objective must not
      // re-arm a breached budget or resurrect a cancelled goal. Lifetime usage
      // and its cumulative baseline therefore always survive `set`.
      // Cancellation is the more fundamental state, so it is reported first.
      if (existing?.status === "cancelled") throw new Error("cancelled goal is terminal")
      if (existing?.limitExceeded) throw new Error(`limit-exceeded: ${existing.limitExceeded}`)
      const goal: Goal = {
        version: 1,
        sessionID,
        objective: trimmed,
        status: "active",
        // The active interval starts now; `withStatus` settles it on the way out.
        activeSince: now,
        createdAt: existing?.createdAt ?? new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        // Lifetime counters survive a new objective, so a new budget cannot be
        // laundered by rewriting the objective text.
        tokensUsed: existing?.tokensUsed ?? 0,
        timeUsedSeconds: existing?.timeUsedSeconds ?? 0,
        costUsed: existing?.costUsed ?? 0,
        // A new (or replaced) objective re-arms the continuation budget and is
        // the only way to clear a recorded budget breach.
        continuations: 0,
        continuationPending: false,
        continuationID: undefined,
        limits: parsedLimits,
        limitExceeded: undefined,
        // The last cumulative report stays the baseline, so usage that happened
        // under the previous objective is still charged to the new budget.
        usageBaseline: existing?.usageBaseline,
      }
      // Lifetime counters are kept, so a fresh objective under a budget already
      // spent must start paused rather than silently re-granting headroom.
      const guarded = enforce(goal)
      write(guarded)
      return guarded
    },
    get: read,
    pause: (sessionID) => setStatus(sessionID, "paused"),
    resume: (sessionID) => setStatus(sessionID, "active"),
    complete: (sessionID) => setStatus(sessionID, "complete"),
    cancel: (sessionID) => {
      const current = read(sessionID)
      if (!current) return null
      // Cancelling is always permitted, including on an already-cancelled goal.
      const next = withStatus(current, "cancelled", {
        continuationPending: false,
        continuationID: undefined,
      })
      write(next)
      return next
    },
    recoverContinuation(sessionID, disposition) {
      if (disposition !== "retry" && disposition !== "abandon")
        throw new Error("invalid-recovery-disposition")
      const current = read(sessionID)
      if (!current) return null
      // Cancellation is terminal: recovering an abandoned admission must not
      // reopen it as paused.
      if (current.status === "cancelled") return current
      if (!current.continuationPending) return current
      const next = withStatus(current, disposition === "abandon" ? "paused" : current.status, {
        continuationPending: false,
        continuationID: undefined,
      })
      write(next)
      return next
    },
    clear(sessionID) {
      try {
        unlinkSync(fileFor(sessionID))
        return true
      } catch {
        return false
      }
    },
    accrueSnapshot(sessionID, usage) {
      validSnapshot(usage)
      const current = read(sessionID)
      if (!current) return null
      const total = (report: UsageSnapshot) =>
        report.tokens.input +
        report.tokens.output +
        report.tokens.reasoning +
        report.tokens.cache.read +
        report.tokens.cache.write
      const baseline = current.usageBaseline
      // Host reports are cumulative session totals. Without a baseline the first
      // report is unknown-prior-usage work, so it only becomes the new base.
      // Any component falling below the base means the host restarted its
      // accounting: rebase without subtracting lifetime usage.
      const rebase =
        !baseline ||
        usage.cost < baseline.cost ||
        total(usage) < total(baseline) ||
        (["input", "output", "reasoning"] as const).some(
          (field) => usage.tokens[field] < baseline.tokens[field],
        ) ||
        (["read", "write"] as const).some(
          (field) => usage.tokens.cache[field] < baseline.tokens.cache[field],
        )
      const next: Goal = {
        ...current,
        updatedAt: new Date().toISOString(),
        tokensUsed: rebase
          ? current.tokensUsed
          : current.tokensUsed + total(usage) - total(baseline),
        costUsed: rebase ? current.costUsed : current.costUsed + usage.cost - baseline.cost,
        usageBaseline: structuredClone(usage),
      }
      if (!Number.isFinite(next.tokensUsed) || !Number.isFinite(next.costUsed)) {
        throw new Error("invalid-usage: aggregate")
      }
      const guarded = enforce(next)
      write(guarded)
      return guarded
    },
    noteContinuation(sessionID) {
      const current = read(sessionID)
      if (!current) return null
      // An unresolved admission is never discarded silently: refuse instead of
      // overwriting the reservation. Cancelled and completed goals never run.
      if (current.continuationPending) throw new Error("unresolved-continuation")
      if (current.status !== "active") return null
      const next: Goal = {
        ...current,
        updatedAt: new Date().toISOString(),
        continuations: current.continuations + 1,
        continuationPending: true,
        continuationID: randomUUID(),
      }
      write(next)
      return next
    },
    finishContinuation(sessionID, admissionID, failed = false) {
      const current = read(sessionID)
      if (!current) return null
      if (current.continuationID !== admissionID) return current
      // A failed admission pauses the goal, never a cancelled one.
      const next = withStatus(
        current,
        failed && current.status !== "cancelled" ? "paused" : current.status,
        { continuationPending: false, continuationID: undefined },
      )
      write(next)
      return next
    },
  }
}
