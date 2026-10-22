import { existsSync } from "node:fs"

export type ReviewedMemory = {
  key: string
  content: string
  tags?: string[]
  revision?: number
}

type GitResult = { code: number; stdout: string; stderr: string }

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>

export type CommitResult = {
  committed: boolean
  files: string[]
  commit: string
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

const DEFAULT_DIR = "omo-memory"

/**
 * Runs git through the local binary. Never uses a shell.
 *
 * `ENOENT` out of `spawn` has two distinct causes: git is not installed, or the
 * working directory does not exist. Collapsing both into `git-unavailable` sends
 * callers hunting for a missing toolchain when the real fault is a bad path, so
 * the cwd is checked here. The check sits in the cold catch branch, never on the
 * success path.
 */
export const runGit: GitRunner = async (args, cwd) => {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      if (!existsSync(cwd)) throw new Error(`git-cwd-missing: ${cwd}`)
      throw new Error("git-unavailable")
    }
    throw error
  }
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

function render(entry: ReviewedMemory): string {
  const header = [
    `# ${entry.key}`,
    entry.revision === undefined ? undefined : `revision: ${entry.revision}`,
    entry.tags?.length ? `tags: ${entry.tags.join(", ")}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
  return `${header}\n\n${entry.content}\n`
}

/**
 * Commits reviewed memories into the repository's memory directory as markdown
 * files and creates one path-limited commit, so unrelated dirty work is neither
 * staged nor committed. Identical content records nothing.
 */
export async function commitReviewedMemories(
  repository: string,
  entries: readonly ReviewedMemory[],
  options: { message?: string; dir?: string; git?: GitRunner } = {},
): Promise<CommitResult> {
  const { realpath, mkdir, writeFile, readFile, rename, rm, readdir } = await import(
    "node:fs/promises"
  )
  const { join } = await import("node:path")
  const git = options.git ?? runGit
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("nothing-to-commit")
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry || typeof entry.key !== "string" || !KEY_PATTERN.test(entry.key))
      throw new Error("invalid-memory-key")
    if (typeof entry.content !== "string" || !entry.content.trim())
      throw new Error("empty-memory-content")
    if (
      entry.tags !== undefined &&
      (!Array.isArray(entry.tags) ||
        entry.tags.some((tag: unknown) => typeof tag !== "string" || !tag.trim()))
    )
      throw new Error("invalid-memory-tags")
    if (entry.revision !== undefined && !Number.isSafeInteger(entry.revision))
      throw new Error("invalid-memory-revision")
    if (seen.has(entry.key)) throw new Error("duplicate-memory-key")
    seen.add(entry.key)
  }
  const dir = options.dir ?? DEFAULT_DIR
  if (
    typeof dir !== "string" ||
    !dir.trim() ||
    dir.includes("\\") ||
    dir.includes("..") ||
    dir.startsWith("/")
  )
    throw new Error("invalid-memory-directory")
  const root = await realpath(repository)
  const inside = await git(["rev-parse", "--show-toplevel"], root)
  if (inside.code !== 0 || (await realpath(inside.stdout.trim())) !== root)
    throw new Error("not-a-repository")
  const files = entries.map((entry) => `${dir}/${entry.key}.md`)
  const rendered = entries.map((entry) => render(entry))
  // A crashed run leaves untracked residue behind, and refusing that state would wedge
  // the memory directory permanently. Two kinds of residue are therefore tolerated: this
  // module's own `.omo-tmp` files, and untracked files this commit is about to overwrite
  // anyway, since nothing is absorbed that was not already reviewed into this batch.
  // Everything else blocks, tracked or not, so a hand-written file is never swept up.
  const dirty = await git(["status", "--porcelain", "--untracked-files=all", "--", dir], root)
  if (dirty.code !== 0) throw new Error("git-status-failed")
  const residue = new Set([...files, ...files.map((file) => `${file}.omo-tmp`)])
  const blocking = dirty.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Porcelain is `XY path`, so the path always starts at index 3.
    .filter((line) => !residue.has(line.slice(3)))
  if (blocking.length > 0) throw new Error("dirty-memory-directory")
  // Refuse to mix a pre-staged index into an automatic commit.
  const staged = await git(["diff", "--cached", "--name-only"], root)
  if (staged.code !== 0) throw new Error("git-status-failed")
  if (staged.stdout.trim()) throw new Error("index-not-clean")
  const current = await Promise.all(
    files.map(async (file) => {
      try {
        return await readFile(join(root, file), "utf8")
      } catch {
        return null
      }
    }),
  )
  if (current.every((text, index) => text === rendered[index]))
    return {
      committed: false,
      files: [],
      commit: (await git(["rev-parse", "HEAD"], root)).stdout.trim(),
    }
  await mkdir(join(root, dir), { recursive: true })
  // `wx` below deliberately refuses to clobber, so leftover temps from a crashed run
  // have to be cleared first or every later attempt fails the same way. Every temp in
  // the directory goes, not just the ones this batch rewrites, because a crashed run
  // may have died on a key that is not part of the current batch.
  const memoryDir = join(root, dir)
  for (const name of await readdir(memoryDir)) {
    if (name.endsWith(".omo-tmp")) await rm(join(memoryDir, name), { force: true })
  }
  const written: Array<{ file: string; before: string | null }> = []
  try {
    for (const [index, file] of files.entries()) {
      const path = join(root, file)
      const temp = `${path}.omo-tmp`
      written.push({ file, before: current[index] ?? null })
      await writeFile(temp, rendered[index] ?? "", { encoding: "utf8", flag: "wx" })
      await rename(temp, path)
    }
    const message =
      typeof options.message === "string" && options.message.trim()
        ? options.message.trim()
        : `omo: record ${files.length} reviewed memor${files.length === 1 ? "y" : "ies"}`
    const add = await git(["add", "--", ...files], root)
    if (add.code !== 0) throw new Error("git-add-failed")
    // Paths are staged explicitly, so the commit stays limited to them and a
    // concurrent index change cannot widen it.
    const commit = await git(["commit", "--quiet", "-m", message, "--", ...files], root)
    if (commit.code !== 0) throw new Error("git-commit-failed")
    const head = await git(["rev-parse", "HEAD"], root)
    if (head.code !== 0 || !head.stdout.trim()) throw new Error("git-head-unavailable")
    return { committed: true, files, commit: head.stdout.trim() }
  } catch (error) {
    // Best-effort: unstaging must never mask the failure being reported.
    await git(["reset", "--quiet", "--", ...written.map((file) => file.file)], root).catch(
      () => undefined,
    )
    for (const file of written.reverse()) {
      const path = join(root, file.file)
      await rm(path, { force: true })
      if (file.before !== null) await writeFile(path, file.before, { encoding: "utf8" })
    }
    throw error
  }
}
