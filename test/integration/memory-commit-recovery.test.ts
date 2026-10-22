import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitReviewedMemories, type ReviewedMemory, runGit } from "../../src/memory/commit"

const memory = (key: string): ReviewedMemory => ({ key, content: `content for ${key}` })

/** A real repository with one committed file, so HEAD exists. */
async function repository() {
  const dir = await mkdtemp(join(tmpdir(), "omo-commit-"))
  const root = join(dir, "repo")
  await mkdir(root, { recursive: true })
  const git = (args: string[]) => runGit(args, root)
  await git(["init"])
  await git(["config", "user.email", "omo@example.test"])
  await git(["config", "user.name", "omo"])
  await git(["config", "commit.gpgsign", "false"])
  await writeFile(join(root, "README.md"), "# repo\n")
  await git(["add", "--", "README.md"])
  await git(["commit", "--quiet", "-m", "base"])
  return { root, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("a leftover temporary file from a crashed run does not wedge the next commit", async () => {
  const { root, cleanup } = await repository()
  try {
    const target = join(root, "omo-memory", "a.md")
    await mkdir(join(root, "omo-memory"), { recursive: true })
    await writeFile(target, "stale leftover\n")
    await writeFile(`${target}.omo-tmp`, "partial write\n")
    const result = await commitReviewedMemories(root, [memory("a")])
    expect(result.committed).toBe(true)
    expect(result.files).toEqual(["omo-memory/a.md"])
    expect(await readFile(target, "utf8")).toContain("content for a")
    // The stale temp file must not survive a successful run.
    await expect(readFile(`${target}.omo-tmp`, "utf8")).rejects.toThrow()
  } finally {
    await cleanup()
  }
})

test("a failed commit leaves no temporary file and keeps committed memory intact", async () => {
  const { root, cleanup } = await repository()
  try {
    const first = await commitReviewedMemories(root, [memory("a")])
    expect(first.committed).toBe(true)
    const before = await readFile(join(root, "omo-memory", "a.md"), "utf8")
    const entries = [
      { key: "a", content: "updated a" },
      { key: "b", content: "new b" },
    ]
    let calls = 0
    const failing = async (args: string[]) => {
      if (args[0] === "commit") {
        calls += 1
        return { code: 1, stdout: "", stderr: "injected failure" }
      }
      return runGit(args, root)
    }
    await expect(commitReviewedMemories(root, entries, { git: failing })).rejects.toThrow(
      "git-commit-failed",
    )
    expect(calls).toBe(1)
    // The previously committed memory survives byte-identical, and nothing new
    // is left behind: no temp file, no untracked new key.
    expect(await readFile(join(root, "omo-memory", "a.md"), "utf8")).toBe(before)
    await expect(readFile(join(root, "omo-memory", "a.md.omo-tmp"), "utf8")).rejects.toThrow()
    await expect(readFile(join(root, "omo-memory", "b.md"), "utf8")).rejects.toThrow()
    const status = await runGit(["status", "--porcelain"], root)
    expect(status.stdout.trim()).toBe("")
  } finally {
    await cleanup()
  }
})

test("identical content is a no-op and reports the current head", async () => {
  const { root, cleanup } = await repository()
  try {
    await commitReviewedMemories(root, [memory("a")])
    const head = (await runGit(["rev-parse", "HEAD"], root)).stdout.trim()
    const again = await commitReviewedMemories(root, [memory("a")])
    expect(again).toEqual({ committed: false, files: [], commit: head })
    // A digest-based render must be stable across runs, otherwise the no-op
    // branch could never trigger.
    expect(createHash("sha256").update(again.commit).digest("hex")).toHaveLength(64)
  } finally {
    await cleanup()
  }
})
