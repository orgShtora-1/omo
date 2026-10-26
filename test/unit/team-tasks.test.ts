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
  const directory = mkdtempSync(join(tmpdir(), "omo team tasks "))
  directories.push(directory)
  const store = openTeamStore(join(directory, "teams.sqlite"), scope)
  stores.push(store)
  return store
}
const base = {
  id: "t",
  leaderID: "parent",
  members: ["parent", "alice"],
  tasks: [{ id: "a", dependencies: [] }],
}

test("listTeams returns every scoped team for the leader and only active memberships otherwise", async () => {
  const store = fixture()
  await store.createTeam(base)
  await store.createTeam({ ...base, id: "t2", members: ["parent", "bob"], tasks: [] })
  expect((await store.listTeams("parent")).map((team) => team.id).sort()).toEqual(["t", "t2"])
  expect((await store.listTeams("alice")).map((team) => team.id)).toEqual(["t"])
  expect(await store.listTeams("carol")).toEqual([])
})

test("addTask appends pending tasks under leader authority with graph validation", async () => {
  const store = fixture()
  const created = await store.createTeam(base)
  await expect(store.addTask("t", "b", [], "alice")).rejects.toThrow("leader-required")
  const added = await store.addTask("t", "b", ["a"], "parent")
  expect(added.tasks.map((task) => task.id).sort()).toEqual(["a", "b"])
  expect(added.revision).toBe(created.revision + 1)
  expect(added.tasks.find((task) => task.id === "b")?.state).toBe("pending")
  await expect(store.addTask("t", "a", [], "parent")).rejects.toThrow("task-exists")
  await expect(store.addTask("t", "c", ["missing"], "parent")).rejects.toThrow("missing dependency")
  await expect(store.addTask("missing", "c", [], "parent")).rejects.toThrow("team-not-found")
})

test("updateTask rewrites pending dependencies and locks active or completed work", async () => {
  const store = fixture()
  await store.createTeam({
    ...base,
    tasks: [
      { id: "a", dependencies: [] },
      { id: "b", dependencies: [] },
    ],
  })
  const updated = await store.updateTask("t", "a", ["b"], "parent")
  expect(updated.tasks.find((task) => task.id === "a")?.dependencies).toEqual(["b"])
  await store.claimTask("t", "b", "alice")
  await expect(store.updateTask("t", "b", [], "parent")).rejects.toThrow("task-locked")
  await expect(store.updateTask("t", "a", ["a"], "parent")).rejects.toThrow("dependency cycle")
  await expect(store.updateTask("t", "a", [], "alice")).rejects.toThrow("leader-required")
  await expect(store.updateTask("t", "ghost", [], "parent")).rejects.toThrow("task-not-found")
})

test("listTasks and getTask guard membership and task identity", async () => {
  const store = fixture()
  await store.createTeam(base)
  expect((await store.listTasks("t", "alice")).map((task) => task.id)).toEqual(["a"])
  expect((await store.getTask("t", "a", "alice")).id).toBe("a")
  await expect(store.listTasks("t", "outsider")).rejects.toThrow("member-inactive")
  await expect(store.getTask("t", "ghost", "alice")).rejects.toThrow("task-not-found")
  await expect(store.listTasks("missing", "alice")).rejects.toThrow("team-not-found")
})
