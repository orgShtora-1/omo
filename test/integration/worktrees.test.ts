import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openTeamStore } from "../../src/teams/claims"
import { openWorktreeManager, type WorktreeManager } from "../../src/worktrees/manager"

const directories: string[] = [],
  managers: WorktreeManager[] = []
const scope = { projectID: "project", parentSessionID: "parent" }
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
}, 30_000)

test("integration requires reviewed commits, refuses dirty targets, and cleans only integrated owned resources", async () => {
  const { repo, manager } = await fixture()
  const handle = await manager.prepareWorktree("implement")
  writeFileSync(join(handle.path, "feature.txt"), "feature")
  await git(handle.path, "add", ".")
  await git(handle.path, "commit", "-m", "feature")
  const changes = await manager.inspectChanges(handle)
  const expectedHead = await git(repo, "rev-parse", "HEAD")
  await expect(manager.cleanup(handle)).rejects.toThrow("unintegrated-work")
  writeFileSync(join(repo, "user.txt"), "retain")
  await expect(
    manager.integrate(handle, { strategy: "merge", reviewedCommit: changes.head, expectedHead }),
  ).rejects.toThrow("dirty-target")
  expect(readFileSync(join(repo, "user.txt"), "utf8")).toBe("retain")
  rmSync(join(repo, "user.txt"))
  await expect(
    manager.integrate(handle, { strategy: "merge", reviewedCommit: "0".repeat(40), expectedHead }),
  ).rejects.toThrow("review-stale")
  expect(
    (
      await manager.integrate(handle, {
        strategy: "merge",
        reviewedCommit: changes.head,
        expectedHead,
      })
    ).state,
  ).toBe("integrated")
  expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("feature")
  await manager.cleanup(handle)
  await manager.cleanup(handle)
  expect(existsSync(handle.path)).toBe(false)
  const foreign = await openWorktreeManager(repo, { ...scope, parentSessionID: "other" })
  managers.push(foreign)
  await expect(foreign.cleanup(handle)).rejects.toThrow("not-owned")
}, 30_000)

test("conflicting integration preserves both branches and supports explicit owned abort after restart", async () => {
  const { repo, manager } = await fixture()
  const handle = await manager.prepareWorktree("conflict")
  writeFileSync(join(handle.path, "file with spaces.txt"), "agent change\n")
  await git(handle.path, "add", ".")
  await git(handle.path, "commit", "-m", "agent")
  writeFileSync(join(repo, "file with spaces.txt"), "leader change\n")
  await git(repo, "add", ".")
  await git(repo, "commit", "-m", "leader")
  const expectedHead = await git(repo, "rev-parse", "HEAD")
  const reviewedCommit = (await manager.inspectChanges(handle)).head
  const result = await manager.integrate(handle, {
    strategy: "merge",
    expectedHead,
    reviewedCommit,
  })
  expect(result.state).toBe("conflict")
  expect(result.conflicts).toContain("file with spaces.txt")
  expect(readFileSync(join(handle.path, "file with spaces.txt"), "utf8")).toBe("agent change\n")
  expect(readFileSync(join(repo, "file with spaces.txt"), "utf8")).toContain("<<<<<<<")
  await expect(manager.cleanup(handle)).rejects.toThrow("recovery-required")
  manager.close()
  const reopened = await openWorktreeManager(repo, scope)
  managers.push(reopened)
  await reopened.abortIntegration(handle)
  expect(readFileSync(join(repo, "file with spaces.txt"), "utf8")).toBe("leader change\n")
  expect(await git(repo, "rev-parse", "HEAD")).toBe(expectedHead)
  await expect(reopened.cleanup(handle)).rejects.toThrow("unintegrated-work")
}, 30_000)
function first<T>(items: readonly T[], what: string): T {
  const item = items[0]
  if (item === undefined) throw new Error(`${what} missing`)
  return item
}
async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exit !== 0) throw new Error(stderr)
  return stdout.trim()
}
async function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "omo real git with spaces "))
  directories.push(repo)
  await git(repo, "init", "-b", "main")
  await git(repo, "config", "user.name", "OmO Fixture")
  await git(repo, "config", "user.email", "fixture@example.invalid")
  await git(repo, "config", "core.autocrlf", "false")
  writeFileSync(join(repo, "file with spaces.txt"), "base\n")
  await git(repo, "add", ".")
  await git(repo, "commit", "-m", "base")
  const manager = await openWorktreeManager(repo, scope)
  managers.push(manager)
  return { repo, manager }
}

test("real worktrees isolate two writers and preserve dirty primary data through restart", async () => {
  const { repo, manager } = await fixture()
  writeFileSync(join(repo, "file with spaces.txt"), "user dirty data\n")
  writeFileSync(join(repo, "user untracked.txt"), "keep")
  const one = await manager.prepareWorktree("task one; spaced")
  const two = await manager.prepareWorktree("task two")
  expect(one.path).not.toBe(two.path)
  expect(readFileSync(join(one.path, "file with spaces.txt"), "utf8")).toBe("base\n")
  writeFileSync(join(one.path, "new file.txt"), "one")
  expect(existsSync(join(two.path, "new file.txt"))).toBe(false)
  expect((await manager.inspectChanges(one)).dirty).toBe(true)
  await expect(manager.cleanup(one)).rejects.toThrow("dirty-worktree")
  expect(readFileSync(join(repo, "file with spaces.txt"), "utf8")).toBe("user dirty data\n")
  manager.close()
  const reopened = await openWorktreeManager(repo, scope)
  managers.push(reopened)
  expect(await reopened.prepareWorktree("task two")).toEqual(two)
  await reopened.cleanup(two)
  await reopened.cleanup(two)
  expect(existsSync(two.path)).toBe(false)
  expect(readFileSync(join(repo, "user untracked.txt"), "utf8")).toBe("keep")
}, 30_000)

test("missing repositories and pre-cancelled preparation do not create resources", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omo no git "))
  directories.push(directory)
  await expect(openWorktreeManager(directory, scope)).rejects.toThrow("repository-required")
  const { manager } = await fixture()
  const controller = new AbortController()
  controller.abort()
  await expect(manager.prepareWorktree("cancelled", controller.signal)).rejects.toThrow("cancelled")
  expect(manager.list()).toEqual([])
}, 30_000)

test("abort during Git preparation retains an uncertain reservation and requires reconciliation before reuse", async () => {
  const { repo, manager } = await fixture()
  const controller = new AbortController()
  const pending = manager.prepareWorktree("cancel during prepare", controller.signal)
  // Poll the public registry so abort occurs after durable admission, not before the operation starts.
  while (manager.list().length === 0) await Bun.sleep(1)
  controller.abort()
  await expect(pending).rejects.toThrow("cancelled")
  const handles = manager.list()
  expect(handles).toHaveLength(1)
  const pendingHandle = first(handles, "cancel during prepare handle")
  await expect(manager.prepareWorktree("cancel during prepare")).rejects.toThrow(
    "recovery-required",
  )
  // A completed checkout can be recovered. An absent/partial checkout remains
  // reserved for explicit recovery rather than claiming a usable resource.
  if (existsSync(pendingHandle.path)) {
    await manager.recoverWorktree(pendingHandle)
    await manager.cleanup(pendingHandle)
  } else {
    await expect(manager.recoverWorktree(pendingHandle)).rejects.toThrow("ownership-mismatch")
    await expect(manager.prepareWorktree("cancel during prepare")).rejects.toThrow(
      "recovery-required",
    )
  }
  expect(readFileSync(join(repo, "file with spaces.txt"), "utf8")).toBe("base\n")
}, 30_000)

test("cleanup preserves ignored data, foreign worktrees and replaced checkout links", async () => {
  const { repo, manager } = await fixture()
  writeFileSync(join(repo, ".gitignore"), "cache.txt\n")
  await git(repo, "add", ".gitignore")
  await git(repo, "commit", "-m", "ignore cache")
  const handle = await manager.prepareWorktree("ignored data")
  writeFileSync(join(handle.path, "cache.txt"), "valuable ignored data")
  await expect(manager.cleanup(handle)).rejects.toThrow("dirty-worktree")
  expect(readFileSync(join(handle.path, "cache.txt"), "utf8")).toBe("valuable ignored data")
  const foreignPath = join(repo, "..", `foreign worktree ${handle.id}`)
  directories.push(foreignPath)
  await git(repo, "worktree", "add", "-b", "user-owned", foreignPath)
  await expect(
    manager.cleanup({ ...handle, path: foreignPath, branch: "user-owned" }),
  ).rejects.toThrow("not-owned")
  expect(existsSync(foreignPath)).toBe(true)
  const clean = await manager.prepareWorktree("link replacement")
  await git(repo, "worktree", "remove", clean.path)
  symlinkSync(foreignPath, clean.path, process.platform === "win32" ? "junction" : "dir")
  await expect(manager.cleanup(clean)).rejects.toThrow("ownership-mismatch")
  expect(existsSync(foreignPath)).toBe(true)
}, 30_000)

test("two independent team tasks run in isolated Git checkouts and only the leader integrates reviewed results", async () => {
  const { repo, manager } = await fixture()
  const store = openTeamStore(join(repo, ".git", "teams.sqlite"), { ...scope, locationID: repo })
  try {
    await store.createTeam({
      id: "parallel",
      leaderID: "leader",
      members: ["leader", "alice", "bob"],
      tasks: [
        { id: "a", dependencies: [] },
        { id: "b", dependencies: [] },
      ],
    })
    const [a, b] = await Promise.all([
      store.claimTask("parallel", "a", "alice"),
      store.claimTask("parallel", "b", "bob"),
    ])
    const [one, two] = await Promise.all([
      manager.prepareWorktree("a"),
      manager.prepareWorktree("b"),
    ])
    await Promise.all(
      [
        [one, "a"],
        [two, "b"],
      ].map(async ([handle, name]) => {
        const owned = handle as typeof one
        writeFileSync(join(owned.path, `${name}.txt`), String(name))
        await git(owned.path, "add", ".")
        await git(owned.path, "commit", "-m", `task ${name}`)
      }),
    )
    await store.completeTask("parallel", "a", a.id, "alice", [one.path])
    await store.completeTask("parallel", "b", b.id, "bob", [two.path])
    for (const [member, handle] of [
      ["alice", one],
      ["bob", two],
    ] as const) {
      const inspected = await manager.inspectChanges(handle)
      await store.sendMessage({
        teamID: "parallel",
        senderID: member,
        recipientID: "leader",
        taskID: handle.taskID,
        dedupKey: `${handle.taskID}-result`,
        body: inspected.head,
      })
    }
    const messages = await store.readMessages("parallel", "leader")
    expect(messages).toHaveLength(2)
    for (const handle of [one, two]) {
      const message = first(
        messages.filter((candidate) => candidate.taskID === handle.taskID),
        `message for task ${handle.taskID}`,
      )
      const result = await manager.integrate(handle, {
        strategy: "merge",
        expectedHead: await git(repo, "rev-parse", "HEAD"),
        reviewedCommit: message.body,
      })
      expect(result.state).toBe("integrated")
      await store.ackMessage("parallel", message.id, "leader")
      await manager.cleanup(handle)
    }
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a")
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("b")
    expect(await store.readMessages("parallel", "leader")).toEqual([])
  } finally {
    store.close()
  }
}, 30_000)
