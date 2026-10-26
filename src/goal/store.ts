import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
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
  /** Close the underlying database connection. */
  close(): void
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

/** Goal records live in a SQLite database under `<dir>/goal.db`. */
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

type GoalRow = {
  session_id: string
  objective: string
  status: string
  created_at: string
  updated_at: string
  tokens_used: number
  time_used_seconds: number
  active_since: number | null
  cost_used: number
  continuations: number
  continuation_pending: number
  continuation_id: string | null
  usage_baseline_cost: number | null
  usage_baseline_input: number | null
  usage_baseline_output: number | null
  usage_baseline_reasoning: number | null
  usage_baseline_cache_read: number | null
  usage_baseline_cache_write: number | null
  limits_max_cost: number | null
  limits_max_tokens: number | null
  limit_exceeded: string | null
}

/**
 * Open the per-session goal store backed by SQLite. A missing or corrupt record
 * reads as null so a damaged record never crashes the host.
 */
export function openGoalStore(dir: string, options: { now?: () => number } = {}): GoalStore {
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, "goal.db")
  const db = new Database(dbPath)
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA journal_mode = WAL")

  db.run(`CREATE TABLE IF NOT EXISTS omo_goals (
    session_id TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    active_since INTEGER,
    cost_used REAL NOT NULL DEFAULT 0,
    continuations INTEGER NOT NULL DEFAULT 0,
    continuation_pending INTEGER NOT NULL DEFAULT 0,
    continuation_id TEXT,
    usage_baseline_cost REAL,
    usage_baseline_input INTEGER,
    usage_baseline_output INTEGER,
    usage_baseline_reasoning INTEGER,
    usage_baseline_cache_read INTEGER,
    usage_baseline_cache_write INTEGER,
    limits_max_cost REAL,
    limits_max_tokens INTEGER,
    limit_exceeded TEXT
  )`)

  const getGoal = db.query<GoalRow, [string]>(
    `SELECT session_id, objective, status, created_at, updated_at, tokens_used,
            time_used_seconds, active_since, cost_used, continuations,
            continuation_pending, continuation_id,
            usage_baseline_cost, usage_baseline_input, usage_baseline_output,
            usage_baseline_reasoning, usage_baseline_cache_read, usage_baseline_cache_write,
            limits_max_cost, limits_max_tokens, limit_exceeded
     FROM omo_goals WHERE session_id = ?`,
  )
  const upsertGoal = db.query(
    `INSERT INTO omo_goals (session_id, objective, status, created_at, updated_at, tokens_used,
      time_used_seconds, active_since, cost_used, continuations, continuation_pending,
      continuation_id, usage_baseline_cost, usage_baseline_input, usage_baseline_output,
      usage_baseline_reasoning, usage_baseline_cache_read, usage_baseline_cache_write,
      limits_max_cost, limits_max_tokens, limit_exceeded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       objective = excluded.objective,
       status = excluded.status,
       updated_at = excluded.updated_at,
       tokens_used = excluded.tokens_used,
       time_used_seconds = excluded.time_used_seconds,
       active_since = excluded.active_since,
       cost_used = excluded.cost_used,
       continuations = excluded.continuations,
       continuation_pending = excluded.continuation_pending,
       continuation_id = excluded.continuation_id,
       usage_baseline_cost = excluded.usage_baseline_cost,
       usage_baseline_input = excluded.usage_baseline_input,
       usage_baseline_output = excluded.usage_baseline_output,
       usage_baseline_reasoning = excluded.usage_baseline_reasoning,
       usage_baseline_cache_read = excluded.usage_baseline_cache_read,
       usage_baseline_cache_write = excluded.usage_baseline_cache_write,
       limits_max_cost = excluded.limits_max_cost,
       limits_max_tokens = excluded.limits_max_tokens,
       limit_exceeded = excluded.limit_exceeded`,
  )
  const deleteGoal = db.query("DELETE FROM omo_goals WHERE session_id = ?")

  function rowToGoal(row: GoalRow): Goal | null {
    // Corrupt active_since: if stored value is not null/number, treat as corrupt
    if (row.active_since !== null && typeof row.active_since !== "number") {
      return null
    }
    const activeSince =
      typeof row.active_since === "number" && Number.isFinite(row.active_since)
        ? row.active_since
        : undefined
    const goal: Goal = {
      version: 1,
      sessionID: row.session_id,
      objective: row.objective,
      status: row.status as GoalStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tokensUsed: row.tokens_used,
      timeUsedSeconds: row.time_used_seconds,
      activeSince,
      costUsed: row.cost_used,
      continuations: row.continuations,
      continuationPending: !!row.continuation_pending,
      continuationID: row.continuation_id ?? undefined,
      usageBaseline:
        row.usage_baseline_cost !== null
          ? {
              cost: row.usage_baseline_cost,
              tokens: {
                input: row.usage_baseline_input ?? 0,
                output: row.usage_baseline_output ?? 0,
                reasoning: row.usage_baseline_reasoning ?? 0,
                cache: {
                  read: row.usage_baseline_cache_read ?? 0,
                  write: row.usage_baseline_cache_write ?? 0,
                },
              },
            }
          : undefined,
      limits:
        row.limits_max_cost !== null || row.limits_max_tokens !== null
          ? {
              ...(row.limits_max_cost !== null ? { maxCost: row.limits_max_cost } : {}),
              ...(row.limits_max_tokens !== null ? { maxTokens: row.limits_max_tokens } : {}),
            }
          : undefined,
      limitExceeded: row.limit_exceeded ? (row.limit_exceeded as LimitDimension) : undefined,
    }
    if (!validateGoalRead(goal)) return null
    return goal
  }

  function validateGoalRead(goal: Goal): boolean {
    if (goal.version !== 1) return false
    if (typeof goal.objective !== "string") return false
    if (!["active", "paused", "complete", "cancelled"].includes(goal.status)) return false
    try {
      if (validateObjective(goal.objective) !== goal.objective) return false
    } catch {
      return false
    }
    if (!Number.isFinite(goal.tokensUsed) || goal.tokensUsed < 0) return false
    if (!Number.isFinite(goal.timeUsedSeconds) || goal.timeUsedSeconds < 0) return false
    if (!Number.isSafeInteger(goal.continuations)) return false
    // activeSince must be a valid positive number when status is "active" AND present.
    // Legacy records may lack activeSince; treat missing as valid for backward compat.
    if (goal.activeSince !== undefined) {
      if (goal.status !== "active") return false
      if (!Number.isFinite(goal.activeSince) || goal.activeSince <= 0) return false
    }
    if (goal.continuationPending !== undefined && typeof goal.continuationPending !== "boolean")
      return false
    if (goal.usageBaseline !== undefined) {
      try {
        validSnapshot(goal.usageBaseline)
      } catch {
        return false
      }
    }
    if (goal.limits !== undefined) {
      try {
        validateLimits(goal.limits)
      } catch {
        return false
      }
    }
    if (
      goal.limitExceeded !== undefined &&
      goal.limitExceeded !== null &&
      !["cost", "tokens"].includes(goal.limitExceeded)
    )
      return false
    if (goal.limitExceeded !== undefined && goal.limitExceeded !== null) {
      if (breachedLimit(goal) !== goal.limitExceeded) return false
    }
    return true
  }

  const read = (sessionID: string): Goal | null => {
    const row = getGoal.get(sessionID)
    if (!row) return null
    return rowToGoal(row)
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

  const withStatus = (current: Goal, status: GoalStatus, extra?: Partial<Goal>): Goal => {
    const clockNow = typeof options.now === "function" ? options.now() : Date.now()
    const leavingActive = current.status === "active" && status !== "active"
    const settled =
      leavingActive && typeof current.activeSince === "number"
        ? Math.max(0, Math.floor((clockNow - current.activeSince) / 1000))
        : 0
    return {
      ...current,
      ...extra,
      status,
      updatedAt: new Date(clockNow).toISOString(),
      timeUsedSeconds: current.timeUsedSeconds + settled,
      activeSince: status === "active" ? clockNow : undefined,
    }
  }

  const enforce = (goal: Goal): Goal => {
    const exceeded = breachedLimit(goal)
    if (!exceeded || goal.status !== "active") {
      return goal.limitExceeded ? { ...goal, limitExceeded: exceeded } : goal
    }
    return withStatus(goal, "paused", { limitExceeded: exceeded })
  }

  const saveGoal = (_sessionID: string, goal: Goal): void => {
    upsertGoal.run(
      goal.sessionID,
      goal.objective,
      goal.status,
      goal.createdAt,
      goal.updatedAt,
      goal.tokensUsed,
      goal.timeUsedSeconds,
      goal.activeSince ?? null,
      goal.costUsed,
      goal.continuations,
      goal.continuationPending ? 1 : 0,
      goal.continuationID ?? null,
      goal.usageBaseline?.cost ?? null,
      goal.usageBaseline?.tokens.input ?? null,
      goal.usageBaseline?.tokens.output ?? null,
      goal.usageBaseline?.tokens.reasoning ?? null,
      goal.usageBaseline?.tokens.cache.read ?? null,
      goal.usageBaseline?.tokens.cache.write ?? null,
      goal.limits?.maxCost ?? null,
      goal.limits?.maxTokens ?? null,
      goal.limitExceeded ?? null,
    )
  }

  return {
    set(sessionID, objective, limits) {
      const trimmed = validateObjective(objective)
      const parsedLimits = validateLimits(limits)
      const clockNow = typeof options.now === "function" ? options.now() : Date.now()
      const now = clockNow
      const existing = read(sessionID)
      if (existing?.status === "cancelled") throw new Error("cancelled goal is terminal")
      if (existing?.limitExceeded) throw new Error(`limit-exceeded: ${existing.limitExceeded}`)
      const goal: Goal = {
        version: 1,
        sessionID,
        objective: trimmed,
        status: "active",
        activeSince: now,
        createdAt: existing?.createdAt ?? new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        tokensUsed: existing?.tokensUsed ?? 0,
        timeUsedSeconds: existing?.timeUsedSeconds ?? 0,
        costUsed: existing?.costUsed ?? 0,
        continuations: 0,
        continuationPending: false,
        continuationID: undefined,
        limits: parsedLimits,
        limitExceeded: undefined,
        usageBaseline: existing?.usageBaseline,
      }
      const guarded = enforce(goal)
      saveGoal(sessionID, guarded)
      return guarded
    },
    get: read,
    pause: (sessionID) => {
      const current = read(sessionID)
      if (!current) return null
      if (current.status === "cancelled") throw new Error("cancelled goal is terminal")
      // Preserve continuations when pausing due to an unresolved continuation;
      // only reset on manual pause (user action via update_goal).
      const next = withStatus(current, "paused", {
        continuations: current.continuationPending ? current.continuations : 0,
        continuationPending: false,
        continuationID: undefined,
      })
      saveGoal(sessionID, next)
      return next
    },
    resume: (sessionID) => {
      const current = read(sessionID)
      if (!current) return null
      if (current.status === "cancelled") throw new Error("cancelled goal is terminal")
      if (current.limitExceeded) throw new Error(`limit-exceeded: ${current.limitExceeded}`)
      if (current.continuationPending) throw new Error("unresolved-continuation")
      const next = withStatus(current, "active", {
        continuations: 0,
        continuationPending: false,
        continuationID: undefined,
      })
      saveGoal(sessionID, next)
      return next
    },
    complete: (sessionID) => {
      const current = read(sessionID)
      if (!current) return null
      if (current.status === "cancelled") throw new Error("cancelled goal is terminal")
      const next = withStatus(current, "complete", {
        continuations: 0,
        continuationPending: false,
        continuationID: undefined,
      })
      saveGoal(sessionID, next)
      return next
    },
    cancel: (sessionID) => {
      const current = read(sessionID)
      if (!current) return null
      const next = withStatus(current, "cancelled", {
        continuationPending: false,
        continuationID: undefined,
      })
      saveGoal(sessionID, next)
      return next
    },
    recoverContinuation(sessionID, disposition) {
      if (disposition !== "retry" && disposition !== "abandon")
        throw new Error("invalid-recovery-disposition")
      const current = read(sessionID)
      if (!current) return null
      if (current.status === "cancelled") return current
      if (!current.continuationPending) return current
      const next = withStatus(current, disposition === "abandon" ? "paused" : current.status, {
        continuationPending: false,
        continuationID: undefined,
      })
      saveGoal(sessionID, next)
      return next
    },
    clear(sessionID) {
      const result = deleteGoal.run(sessionID)
      return (result as { changes: number }).changes > 0
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
      const rebase =
        !baseline ||
        usage.cost < baseline.cost ||
        total(usage) < total(baseline) ||
        (["input", "output", "reasoning"] as const).some(
          (field) => usage.tokens[field] < (baseline.tokens[field] ?? 0),
        ) ||
        (["read", "write"] as const).some(
          (field) => usage.tokens.cache[field] < (baseline.tokens.cache[field] ?? 0),
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
      saveGoal(sessionID, guarded)
      return guarded
    },
    noteContinuation(sessionID) {
      const current = read(sessionID)
      if (!current) return null
      if (current.continuationPending) throw new Error("unresolved-continuation")
      if (current.status !== "active") return null
      const clockNow = typeof options.now === "function" ? options.now() : Date.now()
      const next: Goal = {
        ...current,
        updatedAt: new Date(clockNow).toISOString(),
        continuations: current.continuations + 1,
        continuationPending: true,
        continuationID: randomUUID(),
      }
      saveGoal(sessionID, next)
      return next
    },
    finishContinuation(sessionID, admissionID, failed = false) {
      const current = read(sessionID)
      if (!current) return null
      if (current.continuationID !== admissionID) return current
      const _clockNow = typeof options.now === "function" ? options.now() : Date.now()
      const next = withStatus(
        current,
        failed && current.status !== "cancelled" ? "paused" : current.status,
        { continuationPending: false, continuationID: undefined },
      )
      saveGoal(sessionID, next)
      return next
    },
    close() {
      db.close(true)
    },
  }
}
