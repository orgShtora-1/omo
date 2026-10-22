import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import {
  type Claim,
  createTeam,
  nonempty,
  readTeam,
  type Team,
  TeamError,
  type TeamInput,
  type TeamScope,
  type TeamTask,
  validateScope,
  validateTaskList,
} from "./model"

export type { TeamScope } from "./model"

/** Deletion receipt: the identifier plus the revision it carried when removed. */
type TeamDeletion = { deleted: string; revision: number }

export interface TeamStore {
  createTeam(input: TeamInput): Promise<Team>
  loadTeam(teamID: string): Promise<Team | undefined>
  /** Every team in scope; teams where `memberID` is not an active member are filtered out for non-leaders. */
  listTeams(memberID: string): Promise<Team[]>
  addTask(teamID: string, taskID: string, dependencies: string[], leaderID: string): Promise<Team>
  updateTask(
    teamID: string,
    taskID: string,
    dependencies: string[],
    leaderID: string,
  ): Promise<Team>
  listTasks(teamID: string, memberID: string): Promise<TeamTask[]>
  getTask(teamID: string, taskID: string, memberID: string): Promise<TeamTask>
  claimTask(teamID: string, taskID: string, memberID: string): Promise<Claim>
  removeMember(teamID: string, memberID: string, leaderID: string): Promise<Team>
  completeTask(
    teamID: string,
    taskID: string,
    claimID: string,
    memberID: string,
    evidence: string[],
  ): Promise<Team>
  releaseClaim(
    teamID: string,
    taskID: string,
    claimID: string,
    leaderID: string,
    confirmedStopped: boolean,
  ): Promise<Team>
  sendMessage(input: TeamMessageInput): Promise<string>
  readMessages(teamID: string, memberID: string): Promise<TeamMessage[]>
  ackMessage(teamID: string, messageID: string, memberID: string): Promise<void>
  /** Leader-only immediate removal of the team row and its mailbox. */
  deleteTeam(teamID: string, leaderID: string): Promise<TeamDeletion>
  /** Any active member records shutdown intent; repeated requests are idempotent. */
  requestShutdown(teamID: string, memberID: string): Promise<Team>
  /** Leader-only: executes a pending shutdown request by deleting the team. */
  approveShutdown(teamID: string, leaderID: string): Promise<TeamDeletion>
  /** Leader-only: clears a pending shutdown request without deleting. */
  rejectShutdown(teamID: string, leaderID: string): Promise<Team>
  close(): void
}
type TeamMessageInput = {
  teamID: string
  senderID: string
  recipientID: string
  dedupKey: string
  body: string
  taskID?: string
}
export type TeamMessage = TeamMessageInput & {
  id: string
  createdAt: number
  acknowledgedAt: number | null
}
type MessageRow = { id: string; payload: string; acknowledged_at: number | null }

// The scope is captured once: callers cannot use a message/claim ID to cross project or parent boundaries.
export function openTeamStore(path: string, scope: TeamScope): TeamStore {
  validateScope(scope)
  scope = {
    projectID: scope.projectID,
    locationID: scope.locationID,
    parentSessionID: scope.parentSessionID,
  }
  const key = JSON.stringify([
    "shtora.omo.teams",
    scope.projectID,
    scope.locationID,
    scope.parentSessionID,
  ])
  const db = new Database(path)
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA journal_mode = WAL")
  db.run(
    `CREATE TABLE IF NOT EXISTS omo_teams (scope TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope, id))`,
  )
  db.run(`CREATE TABLE IF NOT EXISTS omo_team_messages (
    scope TEXT NOT NULL, team_id TEXT NOT NULL, id TEXT NOT NULL, sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL, dedup_key TEXT NOT NULL, payload TEXT NOT NULL, acknowledged_at INTEGER,
    PRIMARY KEY(scope, team_id, id), UNIQUE(scope, team_id, sender_id, dedup_key))`)
  const get = db.query<{ payload: string }, [string, string]>(
    "SELECT payload FROM omo_teams WHERE scope = ? AND id = ?",
  )
  function load(id: string): Team | undefined {
    nonempty(id, "team ID")
    const row = get.get(key, id)
    return row ? readTeam(row.payload, scope, id) : undefined
  }
  function required(id: string): Team {
    const team = load(id)
    if (!team) throw new TeamError("team-not-found", id)
    return team
  }
  function active(team: Team, id: string) {
    if (!team.members.some((member) => member.id === id && member.active))
      throw new TeamError("member-inactive", id)
  }
  function leader(team: Team, id: string) {
    active(team, id)
    if (team.leaderID !== id) throw new TeamError("leader-required", id)
  }
  function task(team: Team, id: string) {
    const found = team.tasks.find((task) => task.id === id)
    if (!found) throw new TeamError("task-not-found", id)
    return found
  }
  function save(team: Team) {
    team.revision++
    const payload = JSON.stringify(team)
    readTeam(payload, scope, team.id)
    db.query("UPDATE omo_teams SET payload = ? WHERE scope = ? AND id = ?").run(
      payload,
      key,
      team.id,
    )
  }
  function atomic<T>(operation: () => T): T {
    return db.transaction(operation).immediate()
  }
  /** Removes the team row and every mailbox row; the identifier becomes reusable. */
  function remove(id: string): void {
    db.query("DELETE FROM omo_teams WHERE scope = ? AND id = ?").run(key, id)
    db.query("DELETE FROM omo_team_messages WHERE scope = ? AND team_id = ?").run(key, id)
  }
  function message(row: MessageRow): TeamMessage {
    try {
      const item = JSON.parse(row.payload) as TeamMessage
      if (item.id !== row.id || !Number.isFinite(item.createdAt)) throw new Error("identity")
      for (const field of ["teamID", "senderID", "recipientID", "dedupKey", "body"] as const)
        nonempty(item[field], field)
      return { ...item, acknowledgedAt: row.acknowledged_at }
    } catch {
      throw new TeamError("corrupt-state", "mailbox row retained for diagnosis")
    }
  }
  let closed = false
  return {
    async createTeam(input) {
      return atomic(() => {
        const team = createTeam(input, scope)
        if (load(team.id)) throw new TeamError("team-exists", team.id)
        db.query("INSERT INTO omo_teams VALUES (?, ?, ?)").run(key, team.id, JSON.stringify(team))
        return team
      })
    },
    async loadTeam(id) {
      return load(id)
    },
    async listTeams(memberID) {
      nonempty(memberID, "member ID")
      const teams = db
        .query<{ id: string; payload: string }, [string]>(
          "SELECT id, payload FROM omo_teams WHERE scope = ? ORDER BY rowid",
        )
        .all(key)
        .map((row) => readTeam(row.payload, scope, row.id))
      if (memberID === scope.parentSessionID) return teams
      return teams.filter((team) =>
        team.members.some((member) => member.id === memberID && member.active),
      )
    },
    async addTask(teamID, taskID, dependencies, leaderID) {
      return atomic(() => {
        const team = required(teamID)
        leader(team, leaderID)
        nonempty(taskID, "task ID")
        if (!Array.isArray(dependencies)) throw new TeamError("invalid-input", "dependencies")
        if (team.tasks.some((existing) => existing.id === taskID))
          throw new TeamError("task-exists", taskID)
        const proposed = [
          ...team.tasks.map((existing) => ({
            id: existing.id,
            dependencies: [...existing.dependencies],
          })),
          { id: taskID, dependencies: [...dependencies] },
        ]
        validateTaskList(proposed)
        team.tasks.push({ id: taskID, dependencies: [...dependencies], state: "pending" })
        save(team)
        return team
      })
    },
    async updateTask(teamID, taskID, dependencies, leaderID) {
      return atomic(() => {
        const team = required(teamID)
        leader(team, leaderID)
        const step = task(team, taskID)
        if (step.state !== "pending") throw new TeamError("task-locked", taskID)
        if (!Array.isArray(dependencies)) throw new TeamError("invalid-input", "dependencies")
        const proposed = team.tasks.map((existing) =>
          existing.id === taskID
            ? { id: existing.id, dependencies: [...dependencies] }
            : { id: existing.id, dependencies: [...existing.dependencies] },
        )
        validateTaskList(proposed)
        step.dependencies = [...dependencies]
        save(team)
        return team
      })
    },
    async listTasks(teamID, memberID) {
      const team = required(teamID)
      active(team, memberID)
      return team.tasks
    },
    async getTask(teamID, taskID, memberID) {
      const team = required(teamID)
      active(team, memberID)
      return task(team, taskID)
    },
    async claimTask(teamID, taskID, memberID) {
      return atomic(() => {
        const team = required(teamID)
        active(team, memberID)
        const step = task(team, taskID)
        if (step.state === "claimed" && step.claim?.memberID === memberID) return step.claim
        if (step.state !== "pending") throw new TeamError("already-claimed", taskID)
        if (step.dependencies.some((id) => task(team, id).state !== "completed"))
          throw new TeamError("dependency-blocked", taskID)
        step.claim = { id: randomUUID(), memberID, claimedAt: Date.now() }
        step.state = "claimed"
        save(team)
        return step.claim
      })
    },
    async removeMember(teamID, memberID, leaderID) {
      return atomic(() => {
        const team = required(teamID)
        leader(team, leaderID)
        if (memberID === team.leaderID) throw new TeamError("leader-removal", memberID)
        const member = team.members.find((member) => member.id === memberID)
        if (!member) throw new TeamError("member-inactive", memberID)
        if (!member.active) return team
        member.active = false
        for (const step of team.tasks)
          if (step.state === "claimed" && step.claim?.memberID === memberID) step.state = "blocked"
        save(team)
        return team
      })
    },
    async completeTask(teamID, taskID, claimID, memberID, evidence) {
      return atomic(() => {
        const team = required(teamID)
        active(team, memberID)
        const step = task(team, taskID)
        if (step.claim?.id !== claimID || step.claim.memberID !== memberID)
          throw new TeamError("claim-mismatch", taskID)
        if (!Array.isArray(evidence) || !evidence.length)
          throw new TeamError("evidence-required", taskID)
        for (const ref of evidence) nonempty(ref, "evidence reference")
        if (step.state === "completed") {
          if (JSON.stringify(step.evidence) !== JSON.stringify(evidence))
            throw new TeamError("completion-conflict", taskID)
          return team
        }
        if (step.state !== "claimed") throw new TeamError("claim-blocked", taskID)
        step.state = "completed"
        step.evidence = [...evidence]
        save(team)
        return team
      })
    },
    async releaseClaim(teamID, taskID, claimID, leaderID, confirmedStopped) {
      return atomic(() => {
        const team = required(teamID)
        leader(team, leaderID)
        const step = task(team, taskID)
        if (confirmedStopped !== true) throw new TeamError("reconciliation-required", taskID)
        if (step.claim?.id !== claimID || !["claimed", "blocked"].includes(step.state))
          throw new TeamError("claim-mismatch", taskID)
        delete step.claim
        step.state = "pending"
        save(team)
        return team
      })
    },
    async sendMessage(input) {
      return atomic(() => {
        const team = required(input.teamID)
        active(team, input.senderID)
        active(team, input.recipientID)
        nonempty(input.dedupKey, "dedup key")
        nonempty(input.body, "message body")
        if (input.taskID !== undefined) task(team, input.taskID)
        const canonical: TeamMessageInput = {
          teamID: input.teamID,
          senderID: input.senderID,
          recipientID: input.recipientID,
          dedupKey: input.dedupKey,
          body: input.body,
          ...(input.taskID === undefined ? {} : { taskID: input.taskID }),
        }
        const prior = db
          .query<MessageRow, [string, string, string, string]>(
            "SELECT id, payload, acknowledged_at FROM omo_team_messages WHERE scope = ? AND team_id = ? AND sender_id = ? AND dedup_key = ?",
          )
          .get(key, input.teamID, input.senderID, input.dedupKey)
        if (prior) {
          const { id, createdAt, acknowledgedAt, ...original } = message(prior)
          if (JSON.stringify(original) !== JSON.stringify(canonical))
            throw new TeamError("dedup-conflict", input.dedupKey)
          return id
        }
        const item: TeamMessage = {
          ...canonical,
          id: randomUUID(),
          createdAt: Date.now(),
          acknowledgedAt: null,
        }
        db.query("INSERT INTO omo_team_messages VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(
          key,
          item.teamID,
          item.id,
          item.senderID,
          item.recipientID,
          item.dedupKey,
          JSON.stringify(item),
        )
        return item.id
      })
    },
    async readMessages(teamID, memberID) {
      const team = required(teamID)
      active(team, memberID)
      return db
        .query<MessageRow, [string, string, string]>(
          "SELECT id, payload, acknowledged_at FROM omo_team_messages WHERE scope = ? AND team_id = ? AND recipient_id = ? AND acknowledged_at IS NULL ORDER BY rowid",
        )
        .all(key, teamID, memberID)
        .map(message)
    },
    async ackMessage(teamID, messageID, memberID) {
      atomic(() => {
        const team = required(teamID)
        active(team, memberID)
        const row = db
          .query<MessageRow, [string, string, string, string]>(
            "SELECT id, payload, acknowledged_at FROM omo_team_messages WHERE scope = ? AND team_id = ? AND id = ? AND recipient_id = ?",
          )
          .get(key, teamID, messageID, memberID)
        if (!row) throw new TeamError("message-not-found", messageID)
        message(row)
        db.query(
          "UPDATE omo_team_messages SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE scope = ? AND team_id = ? AND id = ?",
        ).run(Date.now(), key, teamID, messageID)
      })
    },
    async deleteTeam(teamID, leaderID) {
      return atomic(() => {
        const team = required(teamID)
        leader(team, leaderID)
        remove(teamID)
        return { deleted: teamID, revision: team.revision }
      })
    },
    async requestShutdown(teamID, memberID) {
      return atomic(() => {
        const team = required(teamID)
        active(team, memberID)
        if (team.status === "shutdown_requested") return team
        team.status = "shutdown_requested"
        team.shutdownRequestedBy = memberID
        save(team)
        return team
      })
    },
    async approveShutdown(teamID, leaderID) {
      return atomic(() => {
        const team = required(teamID)
        leader(team, leaderID)
        if (team.status !== "shutdown_requested") throw new TeamError("no-shutdown-request", teamID)
        remove(teamID)
        return { deleted: teamID, revision: team.revision }
      })
    },
    async rejectShutdown(teamID, leaderID) {
      return atomic(() => {
        const team = required(teamID)
        leader(team, leaderID)
        if (team.status !== "shutdown_requested") throw new TeamError("no-shutdown-request", teamID)
        team.status = "active"
        delete team.shutdownRequestedBy
        save(team)
        return team
      })
    },
    close() {
      if (!closed) {
        db.close(true)
        closed = true
      }
    },
  }
}
