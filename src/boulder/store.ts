import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
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
 * Session records confine to the state home (`<stateHome>/boulder`), while
 * plan documents resolve and confine against `options.projectRoot` (the
 * project) and fall back to the state home when absent.
 */
export function openBoulderStore(stateHome: string, options?: BoulderOptions): BoulderStore {
  const root = realpathSync(stateHome)
  // A plan is a project document, not plugin state: records stay in the state
  // home while works keep pointing at files in the project.
  const planRoot = options?.projectRoot ? realpathSync(options.projectRoot) : root
  const directory = join(root, "boulder")
  const clock = options?.now ?? Date.now
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1)
    throw new Error("invalid-stale-window")
  function confined(path: string, anchor: string): string {
    const actual = realpathSync(path)
    const rel = relative(anchor, actual)
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("outside-project")
    }
    return actual
  }
  function file(sessionID: string): string {
    if (!sessionID.trim()) throw new Error("native-session-required")
    return join(directory, `${createHash("sha256").update(sessionID).digest("hex")}.json`)
  }
  function plan(path: string): { path: string; text: string } {
    const actual = confined(resolve(planRoot, path), planRoot)
    return { path: relative(planRoot, actual), text: readFileSync(actual, "utf8") }
  }
  function read(sessionID: string): SessionRecord | null {
    const destination = file(sessionID)
    let text: string
    try {
      text = readFileSync(confined(destination, root), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
    return decode(text)
  }
  function write(sessionID: string, record: SessionRecord): SessionRecord {
    mkdirSync(directory, { recursive: true })
    confined(directory, root)
    const destination = file(sessionID)
    const temporary = `${destination}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(record), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    renameSync(temporary, destination)
    return record
  }
  function withWorks(
    sessionID: string,
    change: (record: SessionRecord) => SessionRecord,
  ): SessionRecord {
    const current = read(sessionID) ?? { version: 2, works: [], invitations: [] }
    return write(sessionID, change(current))
  }
  function own(record: SessionRecord | null): SessionRecord {
    if (!record) throw new Error("invalid-work-state")
    return record
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
  return {
    start(sessionID, path) {
      file(sessionID)
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
      withWorks(sessionID, (record) => ({ ...record, works: [...record.works, work] }))
      return work
    },
    get(sessionID, workID) {
      const record = read(sessionID)
      return record ? selected(record, workID) : null
    },
    list(sessionID) {
      return read(sessionID)?.works ?? []
    },
    transition(sessionID, status, workID) {
      if (!statuses.includes(status)) throw new Error("invalid-work-status")
      const current = read(sessionID)
      const work = current ? selected(current, workID) : null
      if (!work) return null
      if (terminal(work.status) && status !== work.status) throw new Error("terminal-work")
      // The sweep marker is deliberately preserved here: only an explicit
      // `recover` clears it, so a stale work never hides from recovery.
      const changed: BoulderWork = {
        ...work,
        status,
        updatedAt: new Date(clock()).toISOString(),
      }
      withWorks(sessionID, (record) => ({
        ...record,
        works: record.works.map((item) => (item.id === work.id ? changed : item)),
      }))
      return changed
    },
    progress(sessionID, workID) {
      const record = read(sessionID)
      const work = record ? selected(record, workID) : null
      return work ? planProgress(plan(work.plan).text) : null
    },
    touch(sessionID, workID) {
      const current = read(sessionID)
      const work = current ? selected(current, workID) : null
      if (!work || terminal(work.status)) return null
      const touched: BoulderWork = { ...work, updatedAt: new Date(clock()).toISOString() }
      withWorks(sessionID, (record) => ({
        ...record,
        works: record.works.map((item) => (item.id === work.id ? touched : item)),
      }))
      return touched
    },
    offer(sessionID, workID, toSessionID) {
      if (!toSessionID.trim()) throw new Error("native-session-required")
      if (toSessionID === sessionID) throw new Error("self-handoff")
      const record = own(read(sessionID))
      const work = record.works.find((item) => item.id === workID)
      if (!work) throw new Error("unknown-work")
      if (terminal(work.status)) throw new Error("terminal-work")
      // The invitation is stored in the recipient's own record: offering never
      // grants the recipient access, it only leaves them something to accept.
      const invitation: HandoffInvitation = {
        workID: work.id,
        fromSessionID: sessionID,
        at: new Date(clock()).toISOString(),
        state: "offered",
      }
      withWorks(toSessionID, (current) => {
        const previous = current.invitations.find((item) => item.workID === work.id)
        if (previous?.state === "claimed") throw new Error("handoff-claimed")
        return {
          ...current,
          invitations: [
            ...current.invitations.filter((item) => item.workID !== work.id),
            invitation,
          ],
        }
      })
      return invitation
    },
    invitations(sessionID) {
      file(sessionID)
      return read(sessionID)?.invitations ?? []
    },
    claim(sessionID, workID) {
      if (!workID.trim()) throw new Error("work-id-required")
      const record = read(sessionID)
      // A session without invitations has nothing to claim.
      if (!record) throw new Error("no-handoff")
      const invitation = record.invitations.find((item) => item.workID === workID)
      if (!invitation) throw new Error("no-handoff")
      if (invitation.state === "claimed") throw new Error("handoff-claimed")
      if (record.works.some((item) => item.id === workID)) throw new Error("duplicate-work")
      const source = own(read(invitation.fromSessionID))
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
      withWorks(sessionID, (current) => ({
        ...current,
        works: [...current.works, claimed],
        invitations: current.invitations.map((item) =>
          item.workID === workID ? { ...item, state: "claimed" } : item,
        ),
      }))
      try {
        // The work leaves the offerer's record: two owners could otherwise
        // transition and sweep the same id independently.
        withWorks(invitation.fromSessionID, (current) => ({
          ...current,
          works: current.works.filter((item) => item.id !== workID),
        }))
      } catch (error) {
        // Undo the claim so the handoff stays retryable instead of leaving the
        // work owned twice or lost.
        try {
          withWorks(sessionID, (current) => ({
            ...current,
            works: current.works.filter((item) => item.id !== workID),
            invitations: current.invitations.map((item) =>
              item.workID === workID ? { ...item, state: "offered" } : item,
            ),
          }))
        } catch {
          // The rollback failure is reported through the original error only.
        }
        throw error
      }
      return claimed
    },
    sweep(sessionID, sweep) {
      const live = sweep?.liveSessions ?? []
      if (!Array.isArray(live) || live.some((item) => typeof item !== "string"))
        throw new Error("invalid-live-sessions")
      const record = read(sessionID)
      if (!record) return []
      const flagged = record.works.filter((work) => !work.stale && stale(work, live))
      if (flagged.length === 0) return []
      const ids = new Set(flagged.map((work) => work.id))
      withWorks(sessionID, (current) => ({
        ...current,
        works: current.works.map((work) => (ids.has(work.id) ? { ...work, stale: true } : work)),
      }))
      return flagged.map((work) => work.id)
    },
    recover(sessionID, workID, disposition) {
      if (!dispositions.includes(disposition)) throw new Error("invalid-recovery-disposition")
      if (typeof workID !== "string" || !workID.trim()) throw new Error("work-id-required")
      const record = read(sessionID)
      const work = record ? selected(record, workID) : null
      if (!work) return null
      if (terminal(work.status)) throw new Error("terminal-work")
      if (!work.stale) throw new Error("stale-work-required")
      const changed: BoulderWork = {
        ...work,
        status: disposition === "abandon" ? "abandoned" : work.status,
        stale: undefined,
        updatedAt: new Date(clock()).toISOString(),
      }
      withWorks(sessionID, (current) => ({
        ...current,
        works: current.works.map((item) => (item.id === work.id ? changed : item)),
      }))
      return changed
    },
  }
}

function terminal(status: WorkStatus): boolean {
  return status === "completed" || status === "abandoned"
}

function decode(text: string): SessionRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("invalid-work-state")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid-work-state")
  const candidate = parsed as Record<string, unknown>
  // Version 1 stored exactly one work per session; reading it stays supported.
  if (candidate.version === 1) {
    if (!validWork(candidate)) throw new Error("invalid-work-state")
    return { version: 2, works: [candidate as unknown as BoulderWork], invitations: [] }
  }
  if (candidate.version !== 2) throw new Error("invalid-work-state")
  if (
    !Array.isArray(candidate.works) ||
    !Array.isArray(candidate.invitations) ||
    new Set((candidate.works as Array<{ id?: unknown }>).map((work) => work?.id)).size !==
      candidate.works.length
  )
    throw new Error("invalid-work-state")
  const works = candidate.works as unknown[]
  const invitations = candidate.invitations as unknown[]
  if (!works.every((work) => validWork(work))) throw new Error("invalid-work-state")
  if (
    !invitations.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        validInvitation(item as Record<string, unknown>),
    )
  )
    throw new Error("invalid-work-state")
  return {
    version: 2,
    works: works as BoulderWork[],
    invitations: invitations as HandoffInvitation[],
  }
}

function validWork(work: unknown): boolean {
  if (!work || typeof work !== "object" || Array.isArray(work)) return false
  const record = work as Record<string, unknown>
  return (
    record.version === 1 &&
    typeof record.id === "string" &&
    Boolean(record.id) &&
    typeof record.sessionID === "string" &&
    Boolean(record.sessionID) &&
    typeof record.plan === "string" &&
    Boolean(record.plan) &&
    typeof record.status === "string" &&
    statuses.includes(record.status as WorkStatus) &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    typeof record.updatedAt === "string" &&
    Number.isFinite(Date.parse(record.updatedAt)) &&
    (record.stale === undefined || typeof record.stale === "boolean") &&
    (record.handedOffFrom === undefined ||
      (typeof record.handedOffFrom === "string" && Boolean(record.handedOffFrom)))
  )
}

function validInvitation(item: Record<string, unknown>): boolean {
  return (
    typeof item.workID === "string" &&
    Boolean(item.workID) &&
    typeof item.fromSessionID === "string" &&
    Boolean(item.fromSessionID) &&
    typeof item.at === "string" &&
    Number.isFinite(Date.parse(item.at)) &&
    (item.state === "offered" || item.state === "claimed")
  )
}
