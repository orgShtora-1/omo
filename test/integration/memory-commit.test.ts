import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitReviewedMemories } from "../../src/memory/commit"

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "omo-memory-commit-"))
  const run = async (args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, stdout, stderr }
  }
  await run(["init", "--quiet"])
  await run(["config", "user.email", "omo@example.test"])
  await run(["config", "user.name", "omo test"])
  await run(["config", "commit.gpgsign", "false"])
  return { root, run, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test("reviewed memories commit as scoped files without touching unrelated work", async () => {
  const { root, run, cleanup } = await repo()
  try {
    await writeFile(join(root, "notes.txt"), "scratch\n")
    const result = await commitReviewedMemories(root, [
      { key: "deploy.staging", content: "deploys go to staging first", tags: ["release"] },
      { key: "test.fixture", content: "the LSP fixture lives in test/fixtures" },
    ])
    expect(result.committed).toBe(true)
    expect(result.files).toEqual(["omo-memory/deploy.staging.md", "omo-memory/test.fixture.md"])
    expect(await run(["rev-parse", "HEAD"])).toMatchObject({ code: 0 })
    const head = (await run(["rev-parse", "HEAD"])).stdout.trim()
    expect(result.commit).toBe(head)
    expect(await readFile(join(root, "omo-memory", "deploy.staging.md"), "utf8")).toContain(
      "deploys go to staging first",
    )
    const shown = (await run(["show", "--name-only", "--format=", "HEAD"])).stdout
    expect(shown).toContain("omo-memory/deploy.staging.md")
    expect(shown).not.toContain("notes.txt")
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("scratch\n")
    expect(await run(["status", "--porcelain"])).toMatchObject({ code: 0 })
    const dirty = (await run(["status", "--porcelain"])).stdout
    // Unrelated work stays outside the commit and outside the index.
    expect(dirty.trim()).toBe("?? notes.txt")
    expect((await run(["diff", "--cached", "--name-only"])).stdout.trim()).toBe("")
  } finally {
    await cleanup()
  }
})

test("identical reviewed content is a recorded no-op that creates no commit", async () => {
  const { root, run, cleanup } = await repo()
  try {
    const entries = [{ key: "deploy.staging", content: "same content" }]
    await commitReviewedMemories(root, entries)
    const first = (await run(["rev-parse", "HEAD"])).stdout.trim()
    const again = await commitReviewedMemories(root, entries)
    expect(again.committed).toBe(false)
    expect((await run(["rev-parse", "HEAD"])).stdout.trim()).toBe(first)
  } finally {
    await cleanup()
  }
})

test("an unreviewed edit in the memory directory blocks the commit and stays untouched", async () => {
  const { root, run, cleanup } = await repo()
  try {
    await commitReviewedMemories(root, [{ key: "deploy.staging", content: "reviewed" }])
    const before = (await run(["rev-parse", "HEAD"])).stdout.trim()
    const manual = join(root, "omo-memory", "manual.md")
    await writeFile(manual, "hand written\n")
    await expect(
      commitReviewedMemories(root, [{ key: "deploy.next", content: "new" }]),
    ).rejects.toThrow("dirty-memory-directory")
    expect((await run(["rev-parse", "HEAD"])).stdout.trim()).toBe(before)
    expect(await readFile(manual, "utf8")).toBe("hand written\n")
  } finally {
    await cleanup()
  }
})

test("a failed commit restores the recorded memory bytes", async () => {
  const { root, run, cleanup } = await repo()
  try {
    await commitReviewedMemories(root, [{ key: "deploy.staging", content: "original" }])
    const file = join(root, "omo-memory", "deploy.staging.md")
    const before = await readFile(file)
    await expect(
      commitReviewedMemories(root, [{ key: "deploy.staging", content: "replacement" }], {
        git: async (args, _cwd) =>
          args[0] === "commit"
            ? { code: 1, stdout: "", stderr: "fatal: injected failure" }
            : await run(args),
      }),
    ).rejects.toThrow("git-commit-failed")
    expect(await readFile(file)).toEqual(before)
  } finally {
    await cleanup()
  }
})

test.each([
  { entries: [], expected: "nothing-to-commit" },
  {
    entries: [
      { key: "same", content: "a" },
      { key: "same", content: "b" },
    ],
    expected: "duplicate-memory-key",
  },
  { entries: [{ key: "../escape", content: "a" }], expected: "invalid-memory-key" },
  { entries: [{ key: "bad key", content: "a" }], expected: "invalid-memory-key" },
  { entries: [{ key: "ok", content: "   " }], expected: "empty-memory-content" },
])("reviewed input is rejected: %j", async ({ entries, expected }) => {
  const { root, cleanup } = await repo()
  const outside = await mkdtemp(join(tmpdir(), "omo-not-repo-"))
  try {
    await expect(commitReviewedMemories(root, entries)).rejects.toThrow(expected)
    await expect(commitReviewedMemories(outside, [{ key: "ok", content: "a" }])).rejects.toThrow(
      "not-a-repository",
    )
    const leftovers = await readdir(root)
    expect(leftovers.filter((name) => name !== ".git")).toEqual([])
  } finally {
    await cleanup()
    await rm(outside, { recursive: true, force: true })
  }
})
