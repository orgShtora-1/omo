import { Database } from "bun:sqlite"
import type { DelegationRequest, ResolvedDelegation } from "../contracts"
export type RunRecord = {
  attemptID: string
  request: DelegationRequest
  resolved: ResolvedDelegation
  sessionID?: string
  phase: "intent" | "prepared" | "admitted" | "completed" | "failed" | "cancelled" | "blocked"
  notification?: "pending" | "sent"
  notificationBatch?: string
  error?: string
  /** Root cause reason for failure/cancellation/block; free text for diagnostics. */
  reason?: string
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  depth?: number
  effectiveModel?: { providerID: string; modelID: string; variant?: string }
}
export function openRunJournal(path: string) {
  const db = new Database(path)
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA journal_mode = WAL")
  db.run("CREATE TABLE IF NOT EXISTS omo_runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_omo_runs_parent_task ON omo_runs(json_extract(payload, '$.request.parentSessionID'), json_extract(payload, '$.request.taskID'))",
  )
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_omo_runs_parent_task_phase ON omo_runs(json_extract(payload, '$.request.parentSessionID'), json_extract(payload, '$.request.taskID'), json_extract(payload, '$.phase'))",
  )
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_omo_runs_scope_phase ON omo_runs(json_extract(payload, '$.scope'), json_extract(payload, '$.phase'))",
  )
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_omo_runs_attempted_at ON omo_runs(json_extract(payload, '$.startedAt') DESC)",
  )
  const get = db.query<{ payload: string }, [string]>("SELECT payload FROM omo_runs WHERE id = ?")
  const all = db.query<{ payload: string }, []>("SELECT payload FROM omo_runs ORDER BY rowid")
  const write = db.query(
    "INSERT INTO omo_runs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
  )
  const read = (id: string): RunRecord => {
    const row = get.get(id)
    if (!row) throw new Error(`unknown-attempt: ${id}`)
    return JSON.parse(row.payload)
  }
  const records = (): RunRecord[] => all.all().map((row) => JSON.parse(row.payload))
  const hasActive = db.query<{ "1": number }, [string, string]>(
    "SELECT 1 FROM omo_runs WHERE json_extract(payload, '$.request.parentSessionID') = ? AND json_extract(payload, '$.request.taskID') = ? AND json_extract(payload, '$.phase') IN ('intent','prepared','admitted','blocked') LIMIT 1",
  )
  const _activeRows = db.query<{ payload: string }, [string, string]>(
    "SELECT payload FROM omo_runs WHERE json_extract(payload, '$.request.parentSessionID') = ? AND json_extract(payload, '$.request.taskID') = ? AND json_extract(payload, '$.phase') IN ('intent','prepared','admitted','blocked') ORDER BY json_extract(payload, '$.updatedAt') DESC",
  )
  const unresolvedRows = db.query<{ payload: string }, []>(
    "SELECT payload FROM omo_runs WHERE json_extract(payload, '$.phase') IN ('intent','prepared','admitted','blocked') ORDER BY rowid",
  )
  const update = (id: string, patch: Partial<RunRecord>) => {
    const record = { ...read(id), ...patch, updatedAt: Date.now() }
    write.run(id, JSON.stringify(record))
    return record
  }
  return {
    intent(attemptID: string, request: DelegationRequest, resolved: ResolvedDelegation) {
      // A durable intent is conservative: a crash before recording the session blocks readmission.
      if (hasActive.get(request.parentSessionID, request.taskID))
        throw new Error(`unreconciled-attempt: ${request.taskID}`)
      const record: RunRecord = {
        attemptID,
        request,
        resolved,
        phase: "intent",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }
      db.query("INSERT INTO omo_runs VALUES (?, ?)").run(attemptID, JSON.stringify(record))
    },
    prepared(attemptID: string, sessionID: string) {
      return update(attemptID, { sessionID, phase: "prepared" })
    },
    admitted(attemptID: string) {
      return update(attemptID, { phase: "admitted" })
    },
    terminal(
      attemptID: string,
      phase: "completed" | "failed" | "cancelled",
      error?: string,
      reason?: string,
    ) {
      return db
        .transaction(() => {
          const current = read(attemptID)
          if (["completed", "failed", "cancelled"].includes(current.phase)) return current
          return update(attemptID, {
            phase,
            finishedAt: current.finishedAt ?? Date.now(),
            ...(error ? { error } : {}),
            ...(reason ? { reason } : {}),
          })
        })
        .immediate()
    },
    block(attemptID: string, error: string) {
      return update(attemptID, { phase: "blocked", error })
    },
    notification(attemptID: string, notification: "pending" | "sent") {
      return db
        .transaction(() => {
          const current = read(attemptID)
          return current.notification === "sent" ? current : update(attemptID, { notification })
        })
        .immediate()
    },
    migrateNotifications() {
      db.transaction(() => {
        for (const item of records())
          if (
            item.notification === "pending" &&
            !item.notificationBatch &&
            ["completed", "failed", "cancelled"].includes(item.phase)
          )
            update(item.attemptID, {
              notificationBatch: `msg_omo_result_${item.attemptID.replaceAll("-", "")}`,
            })
      }).immediate()
    },
    acknowledgeNotificationBatch(batchID: string) {
      db.transaction(() => {
        for (const item of records())
          if (item.notificationBatch === batchID && item.notification !== "sent")
            update(item.attemptID, { notification: "sent" })
      }).immediate()
    },
    claimNotificationBatch(parentSessionID: string) {
      return db
        .transaction(() => {
          const pending = records().filter(
            (item) =>
              item.request.parentSessionID === parentSessionID &&
              item.request.background &&
              ["completed", "failed", "cancelled"].includes(item.phase) &&
              item.notification !== "sent",
          )
          if (!pending.length) return []
          const first = pending[0]
          if (!first) return []
          const existing = pending.find((item) => item.notificationBatch)?.notificationBatch
          const id = existing ?? `msg_omo_results_${first.attemptID.replaceAll("-", "")}`
          const batch = pending.filter((item) =>
            existing ? item.notificationBatch === id : !item.notificationBatch,
          )
          return batch.map((item) =>
            update(item.attemptID, { notification: "pending", notificationBatch: id }),
          )
        })
        .immediate()
    },
    notificationBatch(attemptID: string, notificationBatch: string) {
      return update(attemptID, { notification: "pending", notificationBatch })
    },
    get: read,
    details(attemptID: string, details: Pick<RunRecord, "depth" | "effectiveModel">) {
      return update(attemptID, details)
    },
    list: records,
    unresolved() {
      return unresolvedRows.all().map((row) => JSON.parse(row.payload) as RunRecord)
    },
    retrySafe(parentID: string, taskID: string) {
      return !hasActive.get(parentID, taskID)
    },
    close() {
      db.close(true)
    },
  }
}
