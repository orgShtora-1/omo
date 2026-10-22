import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { computeLineHash } from "../../src/hashline/hash"
import { hashlineCalls } from "../support/hashline-evidence"

// Opt-in live proof that the anchored edit cannot corrupt a file it cannot
// write. The target is marked read-only at the OS level (chmod 0o444) while
// its directory stays writable, so the edit permission gate PASSES but the
// write itself must fail inside `writeAtomic` (src/hashline/atomic.ts): the
// temp file can be created but the rename over the read-only target fails,
// leaving the original bytes untouched and removing the temp file (no
// `.omo-*.tmp` residue). This is the live complement of
// test/unit/hashline-atomic-write.test.ts and completes the read-only
// protection evidence that the DENY probe (permission gate) could not prove.
//
// Requires OMO_LIVE=1 AND runs against the caller's managed host service
// (no `--standalone`): standalone servers own an empty database and see zero
// routable models. Creates one real session (titled below), deleted
// best-effort afterwards; the probe project is a temp dir removed afterwards.
// No global config is modified.
const live = process.env.OMO_LIVE === "1" ? test : test.skip
const MODEL = process.env.OMO_LIVE_MODEL ?? "opencode/deepseek-v4.1-flash-free"
const PRODUCT = "C:/Users/airshakur88/Documents/GitHub/OmO/hallaxius/omo"
const ORIGINAL = "alpha\nbeta\ngamma\n"
// Precomputed with the same function the tool validates against; the prompt
// below instructs a verbatim copy so this probe does not depend on the
// read-enhancer.
const ANCHOR = `1#${computeLineHash(1, "alpha")}`

function dumpEvidence(tag: string, stdout: string, stderr?: string): void {
  try {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
    const evDir = join(tmpdir(), "opencode", "omo-hashline-evidence")
    mkdirSync(evDir, { recursive: true })
    const stamp = Date.now()
    writeFileSync(join(evDir, `${tag}-${stamp}.stdout.jsonl`), stdout, "utf8")
    if (stderr !== undefined)
      writeFileSync(join(evDir, `${tag}-${stamp}.stderr.txt`), stderr, "utf8")
  } catch {
    // Evidence dump is forensic only; ignore failures.
  }
}

async function cleanupSession(sessionID: string | undefined): Promise<void> {
  if (!sessionID) return
  try {
    const child = Bun.spawn(["opencode", "session", "delete", sessionID], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await child.exited
  } catch {
    // Best-effort only; never fail the proof.
  }
}

async function cleanupDir(base: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(base, { recursive: true, force: true })
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
}

live(
  "hashline edit against a read-only file fails without touching bytes or leaving temp residue",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "omo-readonly-"))
    const project = join(base, "project")
    await mkdir(project)
    const notes = join(project, "notes.txt")
    await writeFile(notes, ORIGINAL, "utf8")
    // Read-only file, writable directory: the tool is allowed, the OS refuses
    // the final rename. This is the exact failure window writeAtomic guards.
    await chmod(notes, 0o444)
    const notesPosix = notes.replace(/\\/g, "/")
    await writeFile(
      join(project, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: MODEL,
        permission: { edit: { "*": "allow" }, read: { "*": "allow" } },
        permissions: [
          { action: "edit", resource: "*", effect: "allow" },
          { action: "read", resource: "*", effect: "allow" },
        ],
        plugins: [{ package: PRODUCT, options: { schemaVersion: 1, hashline_edit: true } }],
      }),
    )
    const prompt = `You are verifying failure handling of an anchored-edit tool on a read-only file. Do exactly two things in order. (1) Call omo_hashline_edit directly if listed; otherwise use execute and search for tools.omo.hashline_edit, then attempt exactly that tools.omo.hashline_edit call even if search does not list it. Never substitute filesystem.edit_file, write, or any other tool. Call exactly once with this EXACT payload, copied verbatim: {"filePath": "${notesPosix}", "edits": [{"op": "replace", "pos": "${ANCHOR}", "lines": ["APPLIED-BY-HASHLINE"]}]}. The call is expected to FAIL because the file is read-only; a permission error or EPERM is the correct outcome. Do not retry, do not chmod, and do not edit by any other means. (2) Reply with exactly one line: OMO-READONLY-PROBE status=<applied if the tool reported success, refused otherwise> detail=<paste the tool output or error here>. Do nothing else.`
    const run = Bun.spawn(
      [
        "opencode",
        "run",
        "--agent",
        "executor",
        "--format",
        "json",
        "--title",
        "omo hashline readonly live probe",
        "--model",
        MODEL,
        prompt,
      ],
      { cwd: project, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ])
    let sessionID: string | undefined
    try {
      // The model run finished; parse and assert before touching the disk.
      dumpEvidence("hashline-readonly", stdout, stderr)
      expect(exit, `${stderr}\n${stdout}`).toBe(0)
      const events = stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line)) as Array<Record<string, unknown>>
      sessionID = events[0]?.sessionID as string | undefined
      expect(sessionID, stdout).toBeString()
      const texts = events
        .filter((event) => event.type === "text")
        .map((event) => (event.part as { text?: unknown })?.text)
      expect(texts.join("\n")).toContain("OMO-READONLY-PROBE")
      const calls = hashlineCalls(events)
      expect(calls.length, stdout).toBeGreaterThanOrEqual(1)
      // The write could not have succeeded: no call reports an application.
      const applied = calls
        .map((call) =>
          JSON.stringify((call.part as { state?: { output?: unknown } })?.state?.output ?? ""),
        )
        .join("\n")
      expect(applied).not.toContain("Applied 1 edit")
      // The failure must surface in the tool calls themselves (never rely on
      // the prompt, which also mentions errors).
      const failures = calls
        .map((call) => {
          const state = (call.part as { state?: { error?: unknown; output?: unknown } })?.state
          return JSON.stringify([state?.error ?? null, state?.output ?? null])
        })
        .join("\n")
      expect(failures).toMatch(
        /eperm|operation not permitted|access is denied|denied|read-?only|busy|locked|permission|not allowed|error/i,
      )
      // Disk invariant: byte-identical original.
      const disk = await readFile(notes, "utf8")
      expect(disk).toBe(ORIGINAL)
      // writeAtomic cleanup contract: no temp residue left in the directory.
      const entries = await readdir(project)
      const residue = entries.filter((entry) => /\.omo-.*\.tmp$/.test(entry))
      expect(residue, `residue: ${residue.join(", ")}`).toEqual([])
    } finally {
      // Windows cannot delete read-only files; restore writability first.
      await chmod(notes, 0o666).catch(() => {})
      await cleanupSession(sessionID)
      await cleanupDir(base)
    }
  },
  300_000,
)
