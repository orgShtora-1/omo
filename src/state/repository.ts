import { Database } from "bun:sqlite"
import type { Plan, PlanRepository, Scope } from "../contracts"
import { readPlan, StateError } from "./migrations"

type Row = { plan_id: string; revision: number; payload: string }
const key = (scope: Scope) =>
  JSON.stringify(["shtora.omo", scope.projectID, scope.locationID, scope.parentSessionID])
function decode(scope: Scope, row: Row): Plan {
  const plan = readPlan(row.payload)
  if (
    plan.id !== row.plan_id ||
    plan.revision !== row.revision ||
    plan.projectID !== scope.projectID ||
    plan.parentSessionID !== scope.parentSessionID
  ) {
    throw new StateError("corrupt-state", "row identity/revision mismatch; original row retained")
  }
  return plan
}

// Local-file SQLite serializes writers across connections/processes. No host-storage CAS assumption.
export function openPlanRepository(path: string): PlanRepository {
  const db = new Database(path)
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA journal_mode = WAL")
  db.run(`CREATE TABLE IF NOT EXISTS omo_plans (
    scope TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY (scope, plan_id))`)
  const get = db.query<Row, [string, string]>(
    "SELECT plan_id, revision, payload FROM omo_plans WHERE scope = ? AND plan_id = ?",
  )
  const list = db.query<Row, [string]>(
    "SELECT plan_id, revision, payload FROM omo_plans WHERE scope = ? ORDER BY plan_id",
  )
  const insert = db.query(
    "INSERT INTO omo_plans (scope, plan_id, revision, payload) VALUES (?, ?, ?, ?)",
  )
  const update = db.query(
    "UPDATE omo_plans SET revision = ?, payload = ? WHERE scope = ? AND plan_id = ?",
  )
  const save = db.transaction((scope: Scope, plan: Plan, expectedRevision: number | null) => {
    if (scope.projectID !== plan.projectID || scope.parentSessionID !== plan.parentSessionID) {
      throw new StateError("scope-mismatch", plan.id)
    }
    const scopeKey = key(scope)
    const existing = get.get(scopeKey, plan.id)
    const payload = JSON.stringify(plan)
    readPlan(payload)
    if (existing) decode(scope, existing)
    if (expectedRevision === null) {
      if (existing || plan.revision !== 0) throw new StateError("revision-conflict", plan.id)
      insert.run(scopeKey, plan.id, plan.revision, payload)
      return
    }
    if (!existing || existing.revision !== expectedRevision)
      throw new StateError("revision-conflict", plan.id)
    if (plan.revision === expectedRevision && payload === existing.payload) return
    if (plan.revision !== expectedRevision + 1) throw new StateError("revision-conflict", plan.id)
    update.run(plan.revision, payload, scopeKey, plan.id)
  })
  let closed = false
  return {
    async load(scope, planID) {
      const row = get.get(key(scope), planID)
      return row ? decode(scope, row) : undefined
    },
    async list(scope) {
      return list.all(key(scope)).map((row) => decode(scope, row))
    },
    async save(scope, plan, expectedRevision) {
      save.immediate(scope, plan, expectedRevision)
    },
    close() {
      if (!closed) {
        db.close(true)
        closed = true
      }
    },
  }
}
