import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { ProcessError, runBounded } from "../subprocess.js"
import { type IntegrationResult, type IntegrationReview, mergeReviewedCommit } from "./integration"

export type WorktreeScope = { projectID: string; parentSessionID: string }
type WorktreeHandle = {
  id: string
  taskID: string
  path: string
  branch: string
  baseCommit: string
  repository: string
}
type ChangeSet = {
  head: string
  dirty: boolean
  status: string
  diff: string
  commits: string[]
}
export interface WorktreeManager {
  prepareWorktree(taskID: string, signal?: AbortSignal): Promise<WorktreeHandle>
  inspectChanges(handle: WorktreeHandle): Promise<ChangeSet>
  cleanup(handle: WorktreeHandle): Promise<void>
  list(): WorktreeHandle[]
  recoverWorktree(handle: WorktreeHandle): Promise<WorktreeHandle>
  integrate(handle: WorktreeHandle, review: IntegrationReview): Promise<IntegrationResult>
  abortIntegration(handle: WorktreeHandle): Promise<void>
  close(): void
}
export class WorktreeError extends Error {
  constructor(
    public readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = "WorktreeError"
  }
}
export type GitResult = { exit: number; stdout: string; stderr: string }
export async function runGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  bounds?: { timeoutMs?: number; maxStdout?: number; maxStderr?: number },
): Promise<GitResult> {
  if (signal?.aborted) throw new WorktreeError("cancelled", "Git operation aborted")
  try {
    const result = await runBounded("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
      signal,
      timeoutMs: bounds?.timeoutMs ?? 60_000,
      maxStdout: bounds?.maxStdout ?? 262_144,
      maxStderr: bounds?.maxStderr ?? 32_768,
    })
    return { exit: result.exit, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (error instanceof ProcessError && error.code === "cancelled")
      throw new WorktreeError("cancelled", "Git operation aborted")
    if (error instanceof ProcessError && error.code === "timeout")
      throw new WorktreeError("timeout", `git ${args[0] ?? ""} timed out`.trim())
    throw new WorktreeError(
      signal?.aborted ? "cancelled" : "git-unavailable",
      error instanceof Error ? error.message : String(error),
    )
  }
}
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await runGit(cwd, args, signal)
  if (result.exit !== 0)
    throw new WorktreeError("git-failed", result.stderr.trim() || result.stdout.trim())
  return result.stdout.trim()
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24)
const canonical = (path: string) => realpathSync.native(path)
type State =
  | "preparing"
  | "ready"
  | "cleaning"
  | "cleaned"
  | "recovery"
  | "integrating"
  | "conflict"
type Row = { task_id: string; payload: string; state: State; owner_pid: number }

/** Git argv only; all destructive operations are limited to persisted, suite-owned resources. */
export async function openWorktreeManager(
  directory: string,
  scope: WorktreeScope,
): Promise<WorktreeManager> {
  for (const value of [scope.projectID, scope.parentSessionID])
    if (typeof value !== "string" || !value.trim())
      throw new WorktreeError("invalid-input", "project and parent IDs required")
  const probe = await runGit(directory, ["rev-parse", "--show-toplevel"])
  if (probe.exit !== 0) throw new WorktreeError("repository-required", probe.stderr.trim())
  const repository = canonical(probe.stdout.trim())
  const common = canonical(
    await git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  )
  const key = JSON.stringify([
    "shtora.omo.worktrees",
    scope.projectID,
    scope.parentSessionID,
    repository,
  ])
  const root = join(common, "omo-checkouts", hash(key))
  mkdirSync(root, { recursive: true })
  const db = new Database(join(common, "omo-worktrees.sqlite"))
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA journal_mode = WAL")
  db.run(`CREATE TABLE IF NOT EXISTS omo_worktrees (scope TEXT NOT NULL, task_id TEXT NOT NULL, payload TEXT NOT NULL,
    state TEXT NOT NULL, owner_pid INTEGER NOT NULL, PRIMARY KEY(scope, task_id))`)
  db.run(`CREATE TABLE IF NOT EXISTS omo_worktree_integrations (repository TEXT PRIMARY KEY, scope TEXT NOT NULL,
    handle_id TEXT NOT NULL, expected_head TEXT NOT NULL, reviewed_commit TEXT NOT NULL, owner_pid INTEGER NOT NULL)`)
  const get = db.query<Row, [string, string]>(
    "SELECT task_id, payload, state, owner_pid FROM omo_worktrees WHERE scope = ? AND task_id = ?",
  )
  type IntegrationLock = {
    scope: string
    handle_id: string
    expected_head: string
    reviewed_commit: string
    owner_pid: number
  }
  const integrationLock = () =>
    db
      .query<IntegrationLock, [string]>(
        "SELECT scope, handle_id, expected_head, reviewed_commit, owner_pid FROM omo_worktree_integrations WHERE repository = ?",
      )
      .get(repository)
  function unlock() {
    db.query("DELETE FROM omo_worktree_integrations WHERE repository = ?").run(repository)
  }

  // Critical section for the git commands that mutate $GIT_COMMON_DIR/worktrees.
  //
  // `git worktree add` publishes <worktree>/.git (a `gitdir:` link into
  // <common>/worktrees/<name>) BEFORE it creates `commondir`, and write_file()
  // creates that file empty before filling it. A second git process resolving
  // the repository through the admin dir inside that window reads a
  // zero-length `commondir` and dies in get_common_dir_noenv with
  // "failed to read .../commondir". errno is still 0 at that point, which is
  // why the message ends in the literal "No error" - it is an empty file, not
  // a missing or unreadable one. Git takes no inter-process lock for this
  // window, so we serialize here instead.
  let serial: Promise<unknown> = Promise.resolve()
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = serial.then(operation, operation)
    serial = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function decode(row: Row): WorktreeHandle {
    try {
      const record = JSON.parse(row.payload)
      if (record.schemaVersion > 1)
        throw new WorktreeError("future-version", "worktree registry requires newer plugin")
      const handle = record.handle as WorktreeHandle
      if (
        record.schemaVersion !== 1 ||
        handle.taskID !== row.task_id ||
        handle.repository !== repository ||
        typeof handle.id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(handle.id) ||
        handle.path !== join(root, handle.id) ||
        handle.branch !== `omo/${hash(key)}/${handle.id}` ||
        !/^[0-9a-f]{40,64}$/.test(handle.baseCommit) ||
        ![
          "preparing",
          "ready",
          "cleaning",
          "cleaned",
          "recovery",
          "integrating",
          "conflict",
        ].includes(row.state)
      )
        throw new Error("invalid registry")
      return handle
    } catch (error) {
      if (error instanceof WorktreeError) throw error
      throw new WorktreeError("corrupt-state", "worktree registry retained for diagnosis")
    }
  }
  function owned(handle: WorktreeHandle): Row {
    const row = get.get(key, handle.taskID)
    if (!row || JSON.stringify(decode(row)) !== JSON.stringify(handle))
      throw new WorktreeError("not-owned", "handle does not match this project/parent registry")
    return row
  }
  function state(handle: WorktreeHandle, next: State) {
    db.query(
      "UPDATE omo_worktrees SET state = ?, owner_pid = ? WHERE scope = ? AND task_id = ?",
    ).run(next, process.pid, key, handle.taskID)
  }
  function reserve(handle: WorktreeHandle, next: State) {
    db.transaction(() => {
      const row = owned(handle)
      if (row.state !== "ready")
        throw new WorktreeError("recovery-required", `${row.state}: reconcile before operating`)
      state(handle, next)
    }).immediate()
  }
  async function verify(handle: WorktreeHandle) {
    owned(handle)
    if (!existsSync(handle.path) || canonical(handle.path) !== handle.path)
      throw new WorktreeError("ownership-mismatch", "checkout missing or replaced by a link")
    const top = canonical(await git(handle.path, ["rev-parse", "--show-toplevel"]))
    const gitCommon = canonical(
      await git(handle.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    )
    const branch = await git(handle.path, ["symbolic-ref", "--short", "HEAD"])
    if (top !== handle.path || gitCommon !== common || branch !== handle.branch)
      throw new WorktreeError(
        "ownership-mismatch",
        "checkout/branch changed; preserve for manual recovery",
      )
    const registrations = await git(repository, ["worktree", "list", "--porcelain", "-z"])
    const entries = registrations.split("\0\0").map((entry) => entry.split("\0"))
    if (
      !entries.some(
        (entry) =>
          entry.includes(`worktree ${handle.path.replaceAll("\\", "/")}`) &&
          entry.includes(`branch refs/heads/${handle.branch}`),
      )
    ) {
      // Git normalizes slashes on Windows, but preserves literal spaces and Unicode via -z.
      throw new WorktreeError(
        "ownership-mismatch",
        "Git registration does not match owned checkout",
      )
    }
  }
  async function inspect(handle: WorktreeHandle): Promise<ChangeSet> {
    await verify(handle)
    const [head, status, diff, log] = await Promise.all([
      git(handle.path, ["rev-parse", "HEAD"]),
      git(handle.path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ]),
      git(handle.path, ["diff", "--no-ext-diff", handle.baseCommit, "--"]),
      git(handle.path, ["rev-list", `${handle.baseCommit}..HEAD`]),
    ])
    return { head, dirty: status.length > 0, status, diff, commits: log ? log.split("\n") : [] }
  }
  let closed = false
  return {
    async prepareWorktree(taskID, signal) {
      if (typeof taskID !== "string" || !taskID.trim())
        throw new WorktreeError("invalid-input", "task ID required")
      if (signal?.aborted) throw new WorktreeError("cancelled", "prepare aborted")
      const prior = get.get(key, taskID)
      if (prior) {
        const handle = decode(prior)
        if (prior.state !== "ready")
          throw new WorktreeError(
            "recovery-required",
            `${prior.state}: existing task resource retained`,
          )
        await verify(handle)
        return handle
      }
      const baseCommit = await git(repository, ["rev-parse", "HEAD"], signal)
      const id = randomUUID()
      const handle: WorktreeHandle = {
        id,
        taskID,
        path: join(root, id),
        branch: `omo/${hash(key)}/${id}`,
        baseCommit,
        repository,
      }
      db.transaction(() => {
        if (get.get(key, taskID)) throw new WorktreeError("task-reserved", taskID)
        db.query("INSERT INTO omo_worktrees VALUES (?, ?, ?, 'preparing', ?)").run(
          key,
          taskID,
          JSON.stringify({ schemaVersion: 1, handle }),
          process.pid,
        )
      }).immediate()
      try {
        return await exclusive(async () => {
          // Re-check after queueing: a call aborted while it waited must not go
          // on to create a branch and a worktree admin directory.
          if (signal?.aborted) throw new WorktreeError("cancelled", "prepare aborted")
          await git(
            repository,
            ["worktree", "add", "-b", handle.branch, "--", handle.path, baseCommit],
            signal,
          )
          await verify(handle)
          state(handle, "ready")
          return handle
        })
      } catch (error) {
        state(handle, "recovery")
        throw error
      }
    },
    inspectChanges: inspect,
    async cleanup(handle) {
      const row = owned(handle)
      if (row.state === "cleaned") return
      reserve(handle, "cleaning")
      let removed = false
      try {
        // Cleanup removes an admin directory the prepare path is creating. Same
        // mutual exclusion, so a remove can never observe a half-written one.
        await exclusive(async () => {
          const changes = await inspect(handle)
          if (changes.dirty)
            throw new WorktreeError(
              "dirty-worktree",
              "tracked, untracked or ignored user data must be retained",
            )
          const merged = await runGit(repository, [
            "merge-base",
            "--is-ancestor",
            changes.head,
            "HEAD",
          ])
          if (changes.head !== handle.baseCommit && merged.exit !== 0)
            throw new WorktreeError(
              "unintegrated-work",
              "commits must be explicitly integrated before cleanup",
            )
          await git(repository, ["worktree", "remove", "--", handle.path])
          removed = true
          await git(repository, ["branch", "-d", "--", handle.branch])
          state(handle, "cleaned")
        })
      } catch (error) {
        state(handle, removed ? "recovery" : "ready")
        throw error
      }
    },
    list() {
      return db
        .query<Row, [string]>(
          "SELECT task_id, payload, state, owner_pid FROM omo_worktrees WHERE scope = ? ORDER BY task_id",
        )
        .all(key)
        .map(decode)
    },
    async recoverWorktree(handle) {
      const row = owned(handle)
      if (row.state === "cleaned") throw new WorktreeError("resource-cleaned", handle.taskID)
      if (integrationLock()?.handle_id === handle.id)
        throw new WorktreeError(
          "recovery-required",
          "resolve or explicitly abort owned integration first",
        )
      if (row.state !== "ready" && row.state !== "recovery") {
        try {
          process.kill(row.owner_pid, 0)
          throw new WorktreeError("operation-active", "owning process is still alive")
        } catch (error) {
          if (error instanceof WorktreeError || (error as NodeJS.ErrnoException).code !== "ESRCH")
            throw error
        }
      }
      await verify(handle)
      state(handle, "ready")
      return handle
    },
    async integrate(handle, review) {
      if (
        review.strategy !== "merge" ||
        !/^[0-9a-f]{40,64}$/.test(review.expectedHead) ||
        !/^[0-9a-f]{40,64}$/.test(review.reviewedCommit)
      )
        throw new WorktreeError("invalid-input", "explicit merge review and commit IDs required")
      db.transaction(() => {
        if (integrationLock())
          throw new WorktreeError(
            "integration-busy",
            "another integration or unresolved conflict owns the target",
          )
        reserve(handle, "integrating")
        db.query("INSERT INTO omo_worktree_integrations VALUES (?, ?, ?, ?, ?, ?)").run(
          repository,
          key,
          handle.id,
          review.expectedHead,
          review.reviewedCommit,
          process.pid,
        )
      }).immediate()
      let started = false
      try {
        const changes = await inspect(handle)
        if (changes.head !== review.reviewedCommit)
          throw new WorktreeError("review-stale", "source HEAD differs from reviewed commit")
        if (changes.dirty)
          throw new WorktreeError(
            "dirty-worktree",
            "commit and review source changes before integration",
          )
        const targetHead = await git(repository, ["rev-parse", "HEAD"])
        if (targetHead !== review.expectedHead)
          throw new WorktreeError("target-stale", "target changed since review")
        const dirty = await git(repository, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ])
        if (dirty)
          throw new WorktreeError(
            "dirty-target",
            "commit or preserve target data before explicit integration",
          )
        const mergeHead = await runGit(repository, ["rev-parse", "--verify", "MERGE_HEAD"])
        if (mergeHead.exit === 0)
          throw new WorktreeError("merge-in-progress", "existing user merge preserved")
        started = true
        const result = await mergeReviewedCommit(repository, changes.head)
        if (result.state === "conflict") state(handle, "conflict")
        else {
          state(handle, "ready")
          unlock()
        }
        return result
      } catch (error) {
        if (!started) {
          state(handle, "ready")
          unlock()
        } else state(handle, "recovery")
        throw error
      }
    },
    async abortIntegration(handle) {
      const row = owned(handle),
        lock = integrationLock()
      if (!lock || lock.scope !== key || lock.handle_id !== handle.id)
        throw new WorktreeError("not-owned", "no owned integration to abort")
      if (row.state === "integrating") {
        try {
          process.kill(lock.owner_pid, 0)
          throw new WorktreeError("operation-active", "integration process is still alive")
        } catch (error) {
          if (error instanceof WorktreeError || (error as NodeJS.ErrnoException).code !== "ESRCH")
            throw error
        }
      }
      const mergeHead = await runGit(repository, ["rev-parse", "--verify", "MERGE_HEAD"])
      if (mergeHead.exit === 0) {
        if (
          mergeHead.stdout.trim() !== lock.reviewed_commit ||
          (await git(repository, ["rev-parse", "HEAD"])) !== lock.expected_head
        )
          throw new WorktreeError("ownership-mismatch", "merge changed; no automatic reset")
        await git(repository, ["merge", "--abort"])
      } else {
        const head = await git(repository, ["rev-parse", "HEAD"])
        const merged = await runGit(repository, [
          "merge-base",
          "--is-ancestor",
          lock.reviewed_commit,
          "HEAD",
        ])
        if (head !== lock.expected_head && merged.exit !== 0)
          throw new WorktreeError("integration-uncertain", "target changed outside owned merge")
      }
      await verify(handle)
      state(handle, "ready")
      unlock()
    },
    close() {
      if (!closed) {
        db.close(true)
        closed = true
      }
    },
  }
}
