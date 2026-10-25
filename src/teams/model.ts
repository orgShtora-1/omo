import { type ErrorCode, OmoError } from "../errors/base.js"

export type TeamScope = { projectID: string; locationID: string; parentSessionID: string }
export type TeamInput = {
  id: string
  leaderID: string
  members: string[]
  tasks: { id: string; dependencies: string[] }[]
}
export type Claim = { id: string; memberID: string; claimedAt: number }
export type TeamTask = {
  id: string
  dependencies: string[]
  state: "pending" | "claimed" | "blocked" | "completed"
  claim?: Claim
  evidence?: string[]
}
export type Team = {
  schemaVersion: 1
  id: string
  scope: TeamScope
  revision: number
  leaderID: string
  members: { id: string; active: boolean }[]
  tasks: TeamTask[]
  /** Deletion lifecycle: a shutdown request records intent, approval deletes the team. */
  status: "active" | "shutdown_requested"
  shutdownRequestedBy?: string
}

export class TeamError extends OmoError {
  constructor(code: ErrorCode, detail: string) {
    super(code, `${code}: ${detail}`)
  }
}
export function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new TeamError("invalid-input", label)
}
export function validateScope(scope: TeamScope): void {
  for (const key of ["projectID", "locationID", "parentSessionID"] as const)
    nonempty(scope[key], key)
}
/** Shared task-graph validation: non-empty unique ids, non-empty unique
 * dependencies, every dependency resolvable, and no cycles. */
export function validateTaskList(tasks: { id: string; dependencies: string[] }[]): void {
  for (const task of tasks) {
    nonempty(task.id, "task ID")
    if (!Array.isArray(task.dependencies)) throw new TeamError("invalid-input", "dependencies")
    for (const id of task.dependencies) nonempty(id, "dependency ID")
    if (new Set(task.dependencies).size !== task.dependencies.length)
      throw new TeamError("invalid-input", "duplicate dependency")
  }
  const byID = new Map(tasks.map((task) => [task.id, task]))
  if (byID.size !== tasks.length) throw new TeamError("invalid-input", "duplicate tasks")
  const visiting = new Set<string>(),
    visited = new Set<string>()
  function visit(id: string) {
    if (visiting.has(id)) throw new TeamError("invalid-input", "dependency cycle")
    if (visited.has(id)) return
    const task = byID.get(id)
    if (!task) throw new TeamError("invalid-input", `missing dependency ${id}`)
    visiting.add(id)
    for (const dep of task.dependencies) visit(dep)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.id)
}
export function createTeam(input: TeamInput, scope: TeamScope): Team {
  validateScope(scope)
  nonempty(input.id, "team ID")
  nonempty(input.leaderID, "leader ID")
  if (!Array.isArray(input.members) || !input.members.length || !Array.isArray(input.tasks))
    throw new TeamError("invalid-input", "members/tasks")
  for (const id of input.members) nonempty(id, "member ID")
  if (
    new Set(input.members).size !== input.members.length ||
    !input.members.includes(input.leaderID)
  )
    throw new TeamError("invalid-input", "duplicate members or missing leader")
  validateTaskList(input.tasks)
  const tasks = input.tasks.map((task) => ({
    id: task.id,
    dependencies: [...task.dependencies],
    state: "pending" as const,
  }))
  return {
    schemaVersion: 1,
    id: input.id,
    scope: { ...scope },
    revision: 0,
    leaderID: input.leaderID,
    members: input.members.map((id) => ({ id, active: true })),
    tasks,
    status: "active",
  }
}

export function readTeam(payload: string, scope: TeamScope, id: string): Team {
  try {
    const team = JSON.parse(payload) as Team
    if (team.schemaVersion > 1)
      throw new TeamError("future-version", "team requires a newer plugin")
    if (
      team.schemaVersion !== 1 ||
      team.id !== id ||
      JSON.stringify(team.scope) !== JSON.stringify(scope) ||
      !Number.isSafeInteger(team.revision) ||
      team.revision < 0
    )
      throw new Error("identity/revision")
    createTeam(
      {
        id: team.id,
        leaderID: team.leaderID,
        members: team.members.map((member) => member.id),
        tasks: team.tasks,
      },
      scope,
    )
    for (const member of team.members)
      if (typeof member.active !== "boolean") throw new Error("member")
    // Lifecycle status was added after v1 rows existed: absent means active.
    if (team.status === undefined) team.status = "active"
    if (!["active", "shutdown_requested"].includes(team.status)) throw new Error("lifecycle status")
    if (team.status === "shutdown_requested")
      nonempty(team.shutdownRequestedBy, "shutdown requester")
    else if (team.shutdownRequestedBy !== undefined) throw new Error("stale shutdown requester")
    for (const task of team.tasks) {
      if (!["pending", "claimed", "blocked", "completed"].includes(task.state))
        throw new Error("task state")
      if (task.claim) {
        const claim = task.claim
        nonempty(claim.id, "claim ID")
        nonempty(claim.memberID, "claim owner")
        if (
          !team.members.some((member) => member.id === claim.memberID) ||
          !Number.isFinite(claim.claimedAt)
        )
          throw new Error("claim")
      }
      if (task.state !== "pending" && !task.claim) throw new Error("missing claim")
      if (task.state === "pending" && task.claim) throw new Error("pending claim")
      if (
        task.state === "completed" &&
        (!Array.isArray(task.evidence) ||
          !task.evidence.length ||
          task.evidence.some((ref) => typeof ref !== "string" || !ref.trim()))
      )
        throw new Error("evidence")
    }
    return team
  } catch (error) {
    if (error instanceof TeamError && error.code === "future-version") throw error
    throw new TeamError("corrupt-state", "team row retained for diagnosis")
  }
}
