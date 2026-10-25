import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { type PlanProgress, planProgress } from "./progress"

export type WorkStatus = "active" | "paused" | "completed" | "abandoned"

interface BoulderWork {
  version: 1
  id: string
  sessionID: string
  plan: string
  status: WorkStatus
  createdAt: string
  updatedAt: string
  /** Set by a stale sweep; never set by a heartbeat and never self-clearing. */
  stale?: boolean
  /** Present when this session received the work through an explicit handoff. */
  handedOffFrom?: string
}

interface HandoffInvitation {
  workID: string
  fromSessionID: string
  at: string
  state: "offered" | "claimed"
}

interface SessionRecord {
  version: 2
  works: BoulderWork[]
  invitations: HandoffInvitation[]
}

export interface BoulderOptions {
  now?: () => number
  staleAfterMs?: number
  /**
   * Anchor for resolving and confining plan documents: a plan is a project
   * document, not plugin state. Absent (or empty) falls back to the state
   * home, so records and plan files share one root.
   */
  projectRoot?: string
}

interface StaleSweep {
  liveSessions: readonly string[]
}

export interface BoulderStore {
  start(sessionID: string, plan: string): BoulderWork
  get(sessionID: string, workID?: string): BoulderWork | null
  list(sessionID: string): BoulderWork[]
  transition(sessionID: string, status: WorkStatus, workID?: string): BoulderWork | null
  progress(sessionID: string, workID?: string): PlanProgress | null
  offer(sessionID: string, workID: string, toSessionID: string): HandoffInvitation
  invitations(sessionID: string): HandoffInvitation[]
  claim(sessionID: string, workID: string): BoulderWork
  sweep(sessionID: string, options?: StaleSweep): string[]
  /**
   * Refresh `updatedAt` of the selected non-terminal work. Liveness only: it
   * never changes status and never clears a `stale` flag set by a sweep.
   */
  touch(sessionID: string, workID?: string): BoulderWork | null
  recover(sessionID: string, workID: string, disposition: "resume" | "abandon"): BoulderWork | null
}

const statuses: readonly WorkStatus[] = ["active", "paused", "completed", "abandoned"]
const dispositions = ["resume", "abandon"] as const
const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Own session-local work state; never reads another session's work implicitly.
 * Session records confine to the SQLite database at `<stateHome>/boulder/boulder.db`,
 * while plan documents resolve and confine against `options.projectRoot` (the
 * project) and fall back to the state home when absent.
 */
export function openBoulderStore(stateHome: string, options?: BoulderOptions): BoulderStore {
  const root = realpathSync(stateHome)
  // A plan is a project document, not plugin state: records stay in the state
  // home while works keep pointing at files in the project.
  const planRoot = options?.projectRoot ? realpathSync(options.projectRoot) : root
  const clock = options?.now ?? Date.now
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1)
    throw new Error("invalid-stale-window")

  const dbDir = join(root, "boulder")
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, "boulder.db")
  const db = new Database(dbPath)
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA journal_mode = WAL")

  db.run(`CREATE TABLE IF NOT EXISTS omo_boulder_works (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0,
    handed_off_from TEXT
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS omo_boulder_invitations (
    session_id TEXT NOT NULL,
    from_session_id TEXT NOT NULL,
    work_id TEXT NOT NULL,
    at TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (session_id, from_session_id)
  )`)

  type WorkRow = {
    id: string
    session_id: string
    plan: string
    status: string
    created_at: string
    updated_at: string
    stale: number
    handed_off_from: string | null
  }
  type InvitationRow = {
    session_id: string
    from_session_id: string
    work_id: string
    at: string
    state: string
  }

  const insertWork = db.query(
    "INSERT INTO omo_boulder_works (id, session_id, plan, status, created_at, updated_at, stale, handed_off_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
  const updateWork = db.query(
    "UPDATE omo_boulder_works SET status = ?, updated_at = ?, stale = ?, handed_off_from = ? WHERE id = ? AND session_id = ?",
  )
  const deleteWork = db.query("DELETE FROM omo_boulder_works WHERE id = ? AND session_id = ?")
  const getSessionWorks = db.query<WorkRow, [string]>(
    "SELECT id, session_id, plan, status, created_at, updated_at, stale, handed_off_from FROM omo_boulder_works WHERE session_id = ?",
  )
  const getSessionInvitations = db.query<InvitationRow, [string]>(
    "SELECT work_id, from_session_id, at, state FROM omo_boulder_invitations WHERE session_id = ?",
  )
  const getWork = db.query<WorkRow, [string, string]>(
    "SELECT id, session_id, plan, status, created_at, updated_at, stale, handed_off_from FROM omo_boulder_works WHERE session_id = ? AND id = ?",
  )
  const getInvitation = db.query<InvitationRow, [string, string]>(
    "SELECT work_id, from_session_id, at, state FROM omo_boulder_invitations WHERE session_id = ? AND from_session_id = ?",
  )
  const upsertInvitation = db.query(
    "INSERT INTO omo_boulder_invitations (session_id, from_session_id, work_id, at, state) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, from_session_id) DO UPDATE SET state = excluded.state, at = excluded.at",
  )

  function confined(path: string, anchor: string): string {
    const actual = realpathSync(path)
    const rel = relative(anchor, actual)
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("outside-project")
    }
    return actual
  }

  function plan(path: string): { path: string; text: string } {
    const actual = confined(resolve(planRoot, path), planRoot)
    return { path: relative(planRoot, actual), text: readFileSync(actual, "utf8") }
  }

  function rowToWork(row: WorkRow): BoulderWork {
    if (!statuses.includes(row.status as WorkStatus)) {
      throw new Error("invalid-work-state")
    }
    return {
      version: 1,
      id: row.id,
      sessionID: row.session_id,
      plan: row.plan,
      status: row.status as WorkStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stale: row.stale ? true : undefined,
      handedOffFrom: row.handed_off_from ?? undefined,
    }
  }

  function rowToInvitation(row: InvitationRow): HandoffInvitation {
    if (row.state !== "offered" && row.state !== "claimed") {
      throw new Error("invalid-work-state")
    }
    return {
      workID: row.work_id,
      fromSessionID: row.from_session_id,
      at: row.at,
      state: row.state,
    }
  }

  function own(sessionID: string): SessionRecord {
    const works = getSessionWorks.all(sessionID).map(rowToWork)
    const invitations = getSessionInvitations.all(sessionID).map(rowToInvitation)
    return { version: 2, works, invitations }
  }

  function selected(record: SessionRecord, workID?: string): BoulderWork | null {
    if (workID !== undefined) {
      if (!workID.trim()) throw new Error("work-id-required")
      return record.works.find((work) => work.id === workID) ?? null
    }
    const unfinished = record.works.filter((work) => !terminal(work.status))
    const pool = unfinished.length > 0 ? unfinished : record.works
    return pool[pool.length - 1] ?? null
  }

  function stale(work: BoulderWork, liveSessions: readonly string[]): boolean {
    if (terminal(work.status) || liveSessions.includes(work.sessionID)) return false
    const updated = Date.parse(work.updatedAt)
    if (!Number.isFinite(updated)) throw new Error("invalid-work-state")
    return clock() - updated >= staleAfterMs
  }

  function transaction<T>(fn: () => T): T {
    db.run("BEGIN")
    try {
      const result = fn()
      db.run("COMMIT")
      return result
    } catch (error) {
      try {
        db.run("ROLLBACK")
      } catch {
        // ignore rollback errors
      }
      throw error
    }
  }

  return {
    start(sessionID, path) {
      if (!sessionID.trim()) throw new Error("native-session-required")
      const selected = plan(path)
      const now = new Date(clock()).toISOString()
      const work: BoulderWork = {
        version: 1,
        id: randomUUID(),
        sessionID,
        plan: selected.path,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }
      insertWork.run(
        work.id,
        work.sessionID,
        work.plan,
        work.status,
        work.createdAt,
        work.updatedAt,
        0,
        null,
      )
      return work
    },
    get(sessionID, workID) {
      if (!sessionID.trim()) throw new Error("native-session-required")
      const record = own(sessionID)
      return selected(record, workID)
    },
    list(sessionID) {
      if (!sessionID.trim()) throw new Error("native-session-required")
      return getSessionWorks.all(sessionID).map(rowToWork)
    },
    transition(sessionID, status, workID) {
      if (!statuses.includes(status)) throw new Error("invalid-work-status")
      if (!sessionID.trim()) throw new Error("native-session-required")
      const record = own(sessionID)
      const work = selected(record, workID)
      if (!work) return null
      if (terminal(work.status) && status !== work.status) throw new Error("terminal-work")
      const now = new Date(clock()).toISOString()
      const changed: BoulderWork = {
        ...work,
        status,
        updatedAt: now,
      }
      updateWork.run(
        changed.status,
        changed.updatedAt,
        changed.stale ? 1 : 0,
        changed.handedOffFrom ?? null,
        changed.id,
        changed.sessionID,
      )
      return changed
    },
    progress(sessionID, workID) {
      if (!sessionID.trim()) throw new Error("native-session-required")
      const record = own(sessionID)
      const work = record ? selected(record, workID) : null
      return work ? planProgress(plan(work.plan).text) : null
    },
    touch(sessionID, workID) {
      if (!sessionID.trim()) throw new Error("native-session-required")
      const record = own(sessionID)
      const work = record ? selected(record, workID) : null
      if (!work || terminal(work.status)) return null
      const now = new Date(clock()).toISOString()
      const touched: BoulderWork = { ...work, updatedAt: now }
      updateWork.run(
        touched.status,
        touched.updatedAt,
        touched.stale ? 1 : 0,
        touched.handedOffFrom ?? null,
        touched.id,
        touched.sessionID,
      )
      return touched
    },
    offer(sessionID, workID, toSessionID) {
      if (!sessionID.trim()) throw new Error("native-session-required")
      if (!toSessionID.trim()) throw new Error("native-session-required")
      if (toSessionID === sessionID) throw new Error("self-handoff")
      const record = own(sessionID)
      const work = record.works.find((item) => item.id === workID)
      if (!work) throw new Error("unknown-work")
      if (terminal(work.status)) throw new Error("terminal-work")
      const invitation: HandoffInvitation = {
        workID: work.id,
        fromSessionID: sessionID,
        at: new Date(clock()).toISOString(),
        state: "offered",
      }
      transaction(() => {
        // The invitation is stored in the recipient's own record: offering never
        // grants the recipient access, it only leaves them something to accept.
        const currentInvitations = getSessionInvitations.all(toSessionID).map(rowToInvitation)
        const existing = currentInvitations.find((item) => item.workID === workID)
        if (existing?.state === "claimed") throw new Error("handoff-claimed")
        upsertInvitation.run(
          toSessionID,
          invitation.fromSessionID,
          invitation.workID,
          invitation.at,
          invitation.state,
        )
      })
      return invitation
    },
    invitations(sessionID) {
      if (!sessionID.trim()) throw new Error("native-session-required")
      return getSessionInvitations.all(sessionID).map(rowToInvitation)
    },
    claim(sessionID, workID) {
      if (!sessionID.trim()) throw new Error("native-session-required")
      if (!workID.trim()) throw new Error("work-id-required")
      const record = own(sessionID)
      // A session without invitations has nothing to claim.
      if (!record) throw new Error("no-handoff")
      const invitation = record.invitations.find((item) => item.workID === workID)
      if (!invitation) throw new Error("no-handoff")
      if (invitation.state === "claimed") throw new Error("handoff-claimed")
      if (record.works.some((item) => item.id === workID)) throw new Error("duplicate-work")
      const source = own(invitation.fromSessionID)
      const work = source.works.find((item) => item.id === workID)
      if (!work) throw new Error("unknown-work")
      // Re-resolve the plan inside this project: an invitation never widens scope.
      const resolved = plan(work.plan)
      const claimed: BoulderWork = {
        ...work,
        sessionID,
        plan: resolved.path,
        // A claim is an explicit takeover (like `recover`), so it starts a fresh
        // active interval in the new owner's record instead of carrying the
        // offerer's sweep marker across an ownership change.
        stale: undefined,
        handedOffFrom: invitation.fromSessionID,
        updatedAt: new Date(clock()).toISOString(),
      }
      try {
        transaction(() => {
          // Remove from offerer first so the INSERT for the claimer does not
          // collide on the PRIMARY KEY (work.id is globally unique).
          deleteWork.run(workID, invitation.fromSessionID)
          // Add to claimer's works
          insertWork.run(
            claimed.id,
            claimed.sessionID,
            claimed.plan,
            claimed.status,
            claimed.createdAt,
            claimed.updatedAt,
            0,
            claimed.handedOffFrom ?? null,
          )
          // Mark invitation as claimed
          upsertInvitation.run(
            sessionID,
            invitation.fromSessionID,
            invitation.workID,
            invitation.at,
            "claimed",
          )
        })
      } catch (error) {
        // Undo the claim so the handoff stays retryable instead of leaving the
        // work owned twice or lost.
        try {
          const delResult = deleteWork.run(workID, sessionID)
          if ((delResult as { changes: number }).changes > 0) {
            upsertInvitation.run(sessionID, invitation.fromSessionID, invitation.workID, "offered")
          }
        } catch {
          // The rollback failure is reported through the original error only.
        }
        throw error
      }
      return claimed
    },
    sweep(sessionID, sweep) {
      if (!sessionID.trim()) throw new Error("native-session-required")
      const live = sweep?.liveSessions ?? []
      if (!Array.isArray(live) || live.some((item) => typeof item !== "string"))
        throw new Error("invalid-live-sessions")
      const record = own(sessionID)
      if (!record) return []
      const flagged = record.works.filter((work) => !work.stale && stale(work, live))
      if (flagged.length === 0) return []
      const ids = new Set(flagged.map((work) => work.id))
      transaction(() => {
        for (const work of record.works) {
          if (ids.has(work.id)) {
            updateWork.run(
              work.status,
              work.updatedAt,
              1,
              work.handedOffFrom ?? null,
              work.id,
              work.sessionID,
            )
          }
        }
      })
      return flagged.map((work) => work.id)
    },
    recover(sessionID, workID, disposition) {
      if (!dispositions.includes(disposition)) throw new Error("invalid-recovery-disposition")
      if (typeof workID !== "string" || !workID.trim()) throw new Error("work-id-required")
      if (!sessionID.trim()) throw new Error("native-session-required")
      const record = own(sessionID)
      const work = record ? selected(record, workID) : null
      if (!work) return null
      if (terminal(work.status)) throw new Error("terminal-work")
      if (!work.stale) throw new Error("stale-work-required")
      const now = new Date(clock()).toISOString()
      const changed: BoulderWork = {
        ...work,
        status: disposition === "abandon" ? "abandoned" : work.status,
        stale: undefined,
        updatedAt: now,
      }
      updateWork.run(
        changed.status,
        changed.updatedAt,
        0,
        changed.handedOffFrom ?? null,
        changed.id,
        changed.sessionID,
      )
      return changed
    },
  }
}

function terminal(status: WorkStatus): boolean {
  return status === "completed" || status === "abandoned"
}
