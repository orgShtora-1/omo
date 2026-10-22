import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { openTeamStore, type TeamStore } from "../../src/teams/claims"
import { waitForMessages } from "../../src/teams/mailbox"

const scope = { projectID: "project", locationID: "location", parentSessionID: "parent" }
const directories: string[] = []
const stores: TeamStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "omo teams with spaces "))
  directories.push(directory)
  const path = join(directory, "teams.sqlite")
  const store = openTeamStore(path, scope)
  stores.push(store)
  return { store, path }
}
function first<T>(items: readonly T[], what: string): T {
  const item = items[0]
  if (item === undefined) throw new Error(`${what} missing`)
  return item
}
async function mustLoadTeam(store: TeamStore, teamID: string) {
  const team = await store.loadTeam(teamID)
  if (!team) throw new Error(`team ${teamID} missing`)
  return team
}
const input = {
  id: "team",
  leaderID: "leader",
  members: ["leader", "alice", "bob"],
  tasks: [
    { id: "build", dependencies: [] },
    { id: "review", dependencies: ["build"] },
  ],
}

test("two processes claiming one task have one durable owner across restart", async () => {
  const { store, path } = fixture()
  await store.createTeam(input)
  store.close()
  const moduleURL = pathToFileURL(join(import.meta.dir, "../../src/teams/claims.ts")).href
  async function child(memberID: string) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import { openTeamStore } from ${JSON.stringify(moduleURL)};
      const store = openTeamStore(${JSON.stringify(path)}, ${JSON.stringify(scope)});
      try { console.log(JSON.stringify(await store.claimTask("team", "build", ${JSON.stringify(memberID)}))); }
      catch (error) { console.error(error.code); process.exitCode = 23; }
      finally { store.close(); }
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exit, stdout, stderr }
  }
  const results = await Promise.all([child("alice"), child("bob")])
  expect(results.map((result) => result.exit).sort()).toEqual([0, 23])
  expect(
    first(
      results.filter((result) => result.exit === 23),
      "loser result",
    ).stderr,
  ).toContain("already-claimed")
  const reopened = openTeamStore(path, scope)
  stores.push(reopened)
  const claim = JSON.parse(
    first(
      results.filter((result) => result.exit === 0),
      "winner result",
    ).stdout,
  )
  expect(first((await mustLoadTeam(reopened, "team")).tasks, "build task").claim).toEqual(claim)
  expect(await reopened.claimTask("team", "build", claim.memberID)).toEqual(claim)
})

test("dependencies require evidence and removed owners remain blocked until explicit reconciliation", async () => {
  const { store } = fixture()
  await store.createTeam(input)
  await expect(store.claimTask("team", "review", "bob")).rejects.toThrow("dependency-blocked")
  const claim = await store.claimTask("team", "build", "alice")
  await expect(store.completeTask("team", "build", claim.id, "alice", [])).rejects.toThrow(
    "evidence-required",
  )
  await store.removeMember("team", "alice", "leader")
  await expect(store.claimTask("team", "review", "alice")).rejects.toThrow("member-inactive")
  await expect(
    store.completeTask("team", "build", claim.id, "alice", ["tests.log"]),
  ).rejects.toThrow("member-inactive")
  await expect(store.claimTask("team", "build", "bob")).rejects.toThrow("already-claimed")
  await expect(store.releaseClaim("team", "build", claim.id, "leader", false)).rejects.toThrow(
    "reconciliation-required",
  )
  await store.releaseClaim("team", "build", claim.id, "leader", true)
  const next = await store.claimTask("team", "build", "bob")
  expect(next.id).not.toBe(claim.id)
  await expect(store.completeTask("team", "build", claim.id, "bob", ["tests.log"])).rejects.toThrow(
    "claim-mismatch",
  )
  const completed = await store.completeTask("team", "build", next.id, "bob", ["tests.log"])
  expect((await store.completeTask("team", "build", next.id, "bob", ["tests.log"])).revision).toBe(
    completed.revision,
  )
  expect((await store.claimTask("team", "review", "leader")).memberID).toBe("leader")
})

test("mailbox deduplicates delivery and acknowledgement across restart within project and parent scope", async () => {
  const { store, path } = fixture()
  await store.createTeam(input)
  const message = {
    teamID: "team",
    senderID: "alice",
    recipientID: "leader",
    dedupKey: "result-build",
    body: "Build verified",
    taskID: "build",
  }
  const id = await store.sendMessage(message)
  expect(await store.sendMessage(message)).toBe(id)
  await expect(store.sendMessage({ ...message, body: "Changed result" })).rejects.toThrow(
    "dedup-conflict",
  )
  await expect(store.ackMessage("team", id, "bob")).rejects.toThrow("message-not-found")
  for (const foreignScope of [
    { ...scope, projectID: "foreign" },
    { ...scope, parentSessionID: "foreign" },
    { ...scope, locationID: "foreign" },
  ]) {
    const foreign = openTeamStore(path, foreignScope)
    stores.push(foreign)
    await foreign.createTeam(input)
    expect(await foreign.readMessages("team", "leader")).toEqual([])
    await expect(foreign.ackMessage("team", id, "leader")).rejects.toThrow("message-not-found")
  }
  store.close()
  const reopened = openTeamStore(path, scope)
  stores.push(reopened)
  expect((await reopened.readMessages("team", "leader")).map((message) => message.id)).toEqual([id])
  await reopened.ackMessage("team", id, "leader")
  await reopened.ackMessage("team", id, "leader")
  expect(await reopened.readMessages("team", "leader")).toEqual([])
  expect(await reopened.sendMessage(message)).toBe(id)
  await reopened.removeMember("team", "alice", "leader")
  await expect(reopened.sendMessage({ ...message, dedupKey: "new" })).rejects.toThrow(
    "member-inactive",
  )
})

test("mailbox wait returns pending messages without implicit ack and aborts an idle cadence", async () => {
  const { store } = fixture()
  await store.createTeam(input)
  const controller = new AbortController()
  const waiting = waitForMessages(store, "team", "leader", {
    signal: controller.signal,
    intervalMs: 5,
  })
  await store.sendMessage({
    teamID: "team",
    senderID: "alice",
    recipientID: "leader",
    dedupKey: "ready",
    body: "Ready",
  })
  const messages = await waiting
  expect(messages).toHaveLength(1)
  expect(await store.readMessages("team", "leader")).toHaveLength(1)
  await store.ackMessage("team", first(messages, "delivered message").id, "leader")
  const idle = waitForMessages(store, "team", "leader", {
    signal: controller.signal,
    intervalMs: 60_000,
  })
  controller.abort()
  await expect(idle).rejects.toThrow("abort")
})

test("invalid team graphs and identity collisions cannot replace persisted work", async () => {
  const { store } = fixture()
  await expect(
    store.createTeam({
      ...input,
      tasks: [
        { id: "a", dependencies: ["b"] },
        { id: "b", dependencies: ["a"] },
      ],
    }),
  ).rejects.toThrow("cycle")
  await expect(
    store.createTeam({ ...input, tasks: [{ id: "a", dependencies: ["missing"] }] }),
  ).rejects.toThrow("missing dependency")
  await store.createTeam(input)
  await expect(store.createTeam(input)).rejects.toThrow("team-exists")
  expect((await mustLoadTeam(store, "team")).revision).toBe(0)
})
