import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Evidence } from "../../src/contracts"
import { artifactHashProbe, gitRevisionProbe } from "../../src/evidence/probe"
import { type BoundedOptions, type BoundedResult, ProcessError } from "../../src/subprocess"
import { canCreateFileSymlink } from "../helpers/symlink-privilege"

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex")

type Call = { command: string; args: string[]; options: BoundedOptions }

/** A scripted `runBounded`: each entry answers one spawn, in order. */
const script = (...answers: readonly (BoundedResult | Error)[]) => {
  const calls: Call[] = []
  const run = async (command: string, args: string[], options: BoundedOptions = {}) => {
    calls.push({ command, args, options })
    const answer = answers[calls.length - 1]
    if (answer instanceof Error) throw answer
    if (answer === undefined)
      throw new Error(`unexpected spawn ${calls.length}: ${command} ${args.join(" ")}`)
    return answer
  }
  return { run, calls }
}

const ok = (stdout: string): BoundedResult => ({ exit: 0, stdout, stderr: "", truncated: false })
const failed = (exit: number, stderr = "fatal: bad revision"): BoundedResult => ({
  exit,
  stdout: "",
  stderr,
  truncated: false,
})

const inRepo = {
  dir: ok(".git"),
}

test("a revision a repository resolves is present", async () => {
  const { run, calls } = script(inRepo.dir, ok("0f1e2d3c4b5a69788796a5b4c3d2e1f009182734"))
  const probe = gitRevisionProbe({ run, cwd: "/repo" })
  expect(await probe("0f1e2d3c")).toBe("present")
  expect(calls[0]?.args).toEqual(["rev-parse", "--git-dir"])
  expect(calls[1]?.args).toEqual(["rev-parse", "--verify", "--quiet", "0f1e2d3c^{commit}"])
  expect(calls[0]?.options.cwd).toBe("/repo")
})

test("a directory that is not a repository answers unknown, never absent", async () => {
  const { run } = script(failed(128, "fatal: not a git repository"))
  expect(await gitRevisionProbe({ run, cwd: "/plain" })("0f1e2d3c")).toBe("unknown")
})

test("an unavailable git answers unknown, never absent", async () => {
  const { run } = script(new ProcessError("spawn", "git unavailable"))
  expect(await gitRevisionProbe({ run, cwd: "/repo" })("0f1e2d3c")).toBe("unknown")
})

test("a revision git cannot resolve inside a repository is absent", async () => {
  const { run } = script(inRepo.dir, failed(1))
  expect(await gitRevisionProbe({ run, cwd: "/repo" })("0f1e2d3c")).toBe("absent")
})

// `--quiet` reserves exit 1 for "this ref does not exist here"; every other
// non-zero status is git failing to answer at all (die() exits 128, a usage
// mistake exits 129, a killed child reports a negative code). Only exit 1 is a
// positive observation of absence, so everything else must stay unverifiable.
test("a git failure other than a missing ref is unknown, never absent", async () => {
  const fatal = script(inRepo.dir, failed(128, "fatal: bad object 0f1e2d3c"))
  expect(await gitRevisionProbe({ run: fatal.run, cwd: "/repo" })("0f1e2d3c")).toBe("unknown")

  const usage = script(inRepo.dir, failed(129))
  expect(await gitRevisionProbe({ run: usage.run, cwd: "/repo" })("0f1e2d3c")).toBe("unknown")

  const killed = script(inRepo.dir, failed(-1, ""))
  expect(await gitRevisionProbe({ run: killed.run, cwd: "/repo" })("0f1e2d3c")).toBe("unknown")
})

test("a killed-by-signal git reports a negative exit and is unknown too", async () => {
  const { run } = script(inRepo.dir, { exit: -1, stdout: "", stderr: "", truncated: false })
  expect(await gitRevisionProbe({ run, cwd: "/repo" })("0f1e2d3c")).toBe("unknown")
})

test("a revision git resolves to something unparsable is unknown, never present", async () => {
  const { run } = script(inRepo.dir, ok("HEAD"))
  expect(await gitRevisionProbe({ run, cwd: "/repo" })("HEAD")).toBe("unknown")
})

test("truncated git output is unknown, never present", async () => {
  const { run } = script(inRepo.dir, {
    exit: 0,
    stdout: "0f1e2d3c4b5a69788796a5b4c3d2e1f00918273\n…[omo-truncated: output capped]",
    stderr: "",
    truncated: true,
  })
  expect(await gitRevisionProbe({ run, cwd: "/repo" })("0f1e2d3c")).toBe("unknown")
})

test("a git timeout is unknown, never absent", async () => {
  const { run } = script(new ProcessError("timeout", "git timed out after 5000ms"))
  expect(await gitRevisionProbe({ run, cwd: "/repo" })("0f1e2d3c")).toBe("unknown")
})

test("an aborted signal is unknown and never spawns the resolution", async () => {
  const controller = new AbortController()
  controller.abort()
  const { run, calls } = script(inRepo.dir)
  const probe = gitRevisionProbe({ run, cwd: "/repo", signal: controller.signal })
  expect(await probe("0f1e2d3c")).toBe("unknown")
  expect(calls).toEqual([])
})

test("a revision that git would read as an option is refused without spawning", async () => {
  const { run, calls } = script(inRepo.dir)
  const probe = gitRevisionProbe({ run, cwd: "/repo" })
  expect(await probe("--upload-pack=touch")).toBe("unknown")
  expect(calls).toEqual([])
})

test("a revision containing whitespace is refused without spawning", async () => {
  const { run, calls } = script(inRepo.dir)
  expect(await gitRevisionProbe({ run, cwd: "/repo" })("0f1e2d3c; rm")).toBe("unknown")
  expect(calls).toEqual([])
})

test("the repository check runs once no matter how many revisions are asked about", async () => {
  const { run, calls } = script(
    inRepo.dir,
    ok("a".repeat(40)),
    ok("b".repeat(40)),
    ok("c".repeat(40)),
  )
  const probe = gitRevisionProbe({ run, cwd: "/repo" })
  expect(await Promise.all([probe("r1"), probe("r2"), probe("r3")])).toEqual([
    "present",
    "present",
    "present",
  ])
  expect(calls.filter((call) => call.args.includes("--git-dir"))).toHaveLength(1)
})

test("two distinct revisions are spawned once each", async () => {
  const { run, calls } = script(inRepo.dir, ok("a".repeat(40)), ok("b".repeat(40)))
  const probe = gitRevisionProbe({ run, cwd: "/repo" })
  expect(await probe("0f1e2d3c")).toBe("present")
  expect(await probe("9f8e7d6c")).toBe("present")
  expect(calls.filter((call) => call.args.includes("--verify"))).toHaveLength(2)
})

const withArtifact = async (content: string, declaredHash?: string) => {
  const root = await mkdtemp(join(tmpdir(), "omo-revision-"))
  const name = "report.txt"
  await writeFile(join(root, name), content)
  const item: Evidence = {
    id: "ev-1",
    description: "the artifact",
    artifact: name,
    artifactHash: declaredHash ?? sha256(content),
  }
  return { root, item, probe: artifactHashProbe({ projectRoot: root }) }
}

test("an artifact that still hashes to the declared value is present", async () => {
  const { item, probe } = await withArtifact("hello")
  expect(await probe(item, item.artifact ?? "")).toBe("present")
})

test("an artifact whose content changed is absent", async () => {
  const { item, probe } = await withArtifact("hello")
  expect(await probe({ ...item, artifactHash: sha256("goodbye") }, item.artifact ?? "")).toBe(
    "absent",
  )
})

test("a declared hash that is not sha256 shaped is unknown, never absent", async () => {
  const { item, probe } = await withArtifact("hello")
  expect(await probe({ ...item, artifactHash: "not-a-hash" }, item.artifact ?? "")).toBe("unknown")
})

test("a missing artifact is unknown, never absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-revision-"))
  const item: Evidence = {
    id: "ev-1",
    description: "gone",
    artifact: "absent.txt",
    artifactHash: sha256("hello"),
  }
  expect(await artifactHashProbe({ projectRoot: root })(item, item.artifact ?? "")).toBe("unknown")
})

test("an artifact outside the project root is unknown and never read", async () => {
  const { root, item, probe } = await withArtifact("hello")
  expect(await probe(item, "../escape.txt")).toBe("unknown")
  expect(await probe(item, join(root, "..", "..", "escape.txt"))).toBe("unknown")
})

// The lexical check above only catches `..` written out in the path. A symlink
// keeps the declared path inside the root while pointing somewhere else, so it
// is answered only by resolving the link first — the guard under test here.
// A file symlink needs elevation or Developer Mode on Windows; skip explicitly
// there so stock machines report a skip instead of an EPERM failure. The guard
// itself is unchanged and still verified wherever links can be created.
test.skipIf(!canCreateFileSymlink)(
  "a symlink that leaves the project root is unknown even when the path looks inside",
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "omo-revision-"))
    const root = join(parent, "project")
    await mkdir(root)
    const secret = "outside the project"
    await writeFile(join(parent, "outside.txt"), secret)
    await symlink(join(parent, "outside.txt"), join(root, "link.txt"))
    // The declared hash matches the file the link points at, so a probe that
    // followed the link would answer `present`. It must not read it at all.
    const item: Evidence = {
      id: "ev-1",
      description: "via link",
      artifact: "link.txt",
      artifactHash: sha256(secret),
    }
    expect(await artifactHashProbe({ projectRoot: root })(item, item.artifact ?? "")).toBe(
      "unknown",
    )
  },
)

test("a symlinked directory that leaves the project root is unknown too", async () => {
  const parent = await mkdtemp(join(tmpdir(), "omo-revision-"))
  const root = join(parent, "project")
  const outsideDir = join(parent, "outside-dir")
  await mkdir(root)
  await mkdir(outsideDir)
  await writeFile(join(outsideDir, "report.txt"), "buried outside")
  await symlink(outsideDir, join(root, "dir"), "junction")
  const item: Evidence = {
    id: "ev-1",
    description: "via link dir",
    artifact: join("dir", "report.txt"),
    artifactHash: sha256("buried outside"),
  }
  expect(await artifactHashProbe({ projectRoot: root })(item, item.artifact ?? "")).toBe("unknown")
})

test("a declared hash compares case-insensitively, as sha256 hex is", async () => {
  const { item, probe } = await withArtifact("hello")
  const upper = (item.artifactHash ?? "").toUpperCase()
  expect(await probe({ ...item, artifactHash: upper }, item.artifact ?? "")).toBe("present")
})

test("an artifact larger than the cap is unknown and never read", async () => {
  const { root, item } = await withArtifact("x".repeat(4_096))
  const probe = artifactHashProbe({ projectRoot: root, maxBytes: 16 })
  expect(await probe(item, item.artifact ?? "")).toBe("unknown")
})

test("an aborted signal is unknown for an artifact too", async () => {
  const controller = new AbortController()
  controller.abort()
  const { root, item } = await withArtifact("hello")
  const probe = artifactHashProbe({ projectRoot: root, signal: controller.signal })
  expect(await probe(item, item.artifact ?? "")).toBe("unknown")
})
