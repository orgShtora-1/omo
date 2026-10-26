import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openTeamStore, type TeamStore } from "../../src/teams/claims"
import { rmSyncRetry } from "./test-utils"

const scope = { projectID: "project", locationID: "location", parentSessionID: "parent" }
const directories: string[] = []
const stores: TeamStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSyncRetry(directory)
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "omo team lifecycle "))
  directories.push(directory)
  const path = join(directory, "teams.sqlite")
  const store = openTeamStore(path, scope)
  stores.push(store)
  return { store, path }
}
const base = {
  id: "t",
  leaderID: "parent",
  members: ["parent", "alice"],
  tasks: [{ id: "a", dependencies: [] }],
}

test("deleteTeam removes the team and its mailbox under leader authority", async () => {
  const { store } = fixture()
  await store.createTeam(base)
  await store.sendMessage({
    teamID: "t",
    senderID: "parent",
    recipientID: "alice",
    dedupKey: "d1",
    body: "hello",
  })
  await expect(store.deleteTeam("t", "alice")).rejects.toThrow("leader-required")
  await expect(store.deleteTeam("missing", "parent")).rejects.toThrow("team-not-found")
  const deleted = await store.deleteTeam("t", "parent")
  expect(deleted).toMatchObject({ deleted: "t" })
  expect(await store.loadTeam("t")).toBeUndefined()
  expect(await store.listTeams("parent")).toEqual([])
  await expect(store.addTask("t", "b", [], "parent")).rejects.toThrow("team-not-found")
  await expect(store.readMessages("t", "alice")).rejects.toThrow("team-not-found")
  // The identifier is reusable after deletion.
  const recreated = await store.createTeam(base)
  expect(recreated.id).toBe("t")
  expect(recreated.status).toBe("active")
})

test("shutdown lifecycle requests, rejects and approves deletion", async () => {
  const { store } = fixture()
  const created = await store.createTeam(base)
  await expect(store.approveShutdown("t", "parent")).rejects.toThrow("no-shutdown-request")
  await expect(store.rejectShutdown("t", "parent")).rejects.toThrow("no-shutdown-request")
  await expect(store.requestShutdown("t", "outsider")).rejects.toThrow("member-inactive")
  const requested = await store.requestShutdown("t", "alice")
  expect(requested.status).toBe("shutdown_requested")
  expect(requested.shutdownRequestedBy).toBe("alice")
  expect(requested.revision).toBe(created.revision + 1)
  // A repeated request is idempotent: no extra revision.
  const repeated = await store.requestShutdown("t", "parent")
  expect(repeated.status).toBe("shutdown_requested")
  expect(repeated.revision).toBe(requested.revision)
  await expect(store.approveShutdown("t", "alice")).rejects.toThrow("leader-required")
  const rejected = await store.rejectShutdown("t", "parent")
  expect(rejected.status).toBe("active")
  expect(rejected.shutdownRequestedBy).toBeUndefined()
  await store.requestShutdown("t", "alice")
  const approved = await store.approveShutdown("t", "parent")
  expect(approved).toMatchObject({ deleted: "t" })
  expect(await store.loadTeam("t")).toBeUndefined()
})

test("legacy rows without lifecycle status read as active", async () => {
  const { store, path } = fixture()
  await store.createTeam(base)
  store.close()
  const raw = new Database(path)
  try {
    const row = raw.query<{ payload: string }, []>("SELECT payload FROM omo_teams").get()
    if (!row) throw new Error("team row was not persisted")
    const legacy = JSON.parse(row.payload) as Record<string, unknown>
    delete legacy.status
    delete legacy.shutdownRequestedBy
    raw.query("UPDATE omo_teams SET payload = ?").run(JSON.stringify(legacy))
  } finally {
    raw.close(true)
  }
  const reopened = openTeamStore(path, scope)
  stores.push(reopened)
  const team = await reopened.loadTeam("t")
  expect(team?.status).toBe("active")
})
