import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { computeLineHash } from "../../src/hashline/hash"
import { hashlineCalls } from "../support/hashline-evidence"

// Opt-in live snapshot of native allow/deny over `hashline_edit` (tool id
// `omo_hashline_edit`, namespace `omo`, permission `edit`,
// src/hashline/tools.ts:47-50). The tool is gated by the `hashline_edit`
// plugin option.
//
// Earlier probes omitted V2 result.content support and incorrectly diagnosed
// the host as mutation-inert. After the content fix, a 2026-10-08 live run
// showed anchors in native read output (ALLOW and DENY). Enable the independent
// native-read gate with OMO_HASHLINE_REQUIRE_READ_ANCHORS=1. The edit payload
// still uses a precomputed anchor so edit and enhancer evidence stay separate.
//
// - Allow path: with `edit * allow` the model calls the edit tool with the
//   precomputed anchor and the file on disk changes exactly as specified.
//   This proves the anchored-edit tool executes end-to-end (fresh-anchor
//   validation accepts the reference, "Applied 1 edit", disk EDITED).
// - Deny path: with per-agent `edit * deny` (agents.executor, appended
//   after the global allow — same layering as the pc-deny-8 run) the attempt
//   is refused fail-closed in either observed form: an explicit host
//   permission error, or sandbox hiding ("Unknown tool") so the call cannot
//   even be constructed. In both forms the file on disk is byte-identical.
//
// Requires OMO_LIVE=1 AND runs against the caller's managed host service
// (no `--standalone`): standalone servers own an empty database and see zero
// routable models. Each probe creates one real session (titled below) in the
// caller's host; sessions are deleted best-effort afterwards. The probe
// project is a temp dir removed afterwards; no global config is modified.
//
// The agent runs directly as executor (covered by test/live/agents.test.ts):
// no delegation is involved, so this pins the edit permission gate only.
const live = process.env.OMO_LIVE === "1" ? test : test.skip
const MODEL = process.env.OMO_LIVE_MODEL ?? "opencode/deepseek-v4.1-flash-free"
const PRODUCT = "C:/Users/airshakur88/Documents/GitHub/OmO/hallaxius/omo"
const ORIGINAL = "alpha\nbeta\ngamma\n"
const EDITED = "APPLIED-BY-HASHLINE\nbeta\ngamma\n"
// Precomputed with the same function the tool validates against; the prompt
// below instructs a verbatim copy so the allow path does not depend on the
// read-enhancer.
const ANCHOR = `1#${computeLineHash(1, "alpha")}`

interface ProbeConfig {
  title: string
  agentEditEffect: "allow" | "deny"
  taskID: string
}

async function setupProject(agentEditEffect: "allow" | "deny"): Promise<{
  base: string
  project: string
  notesPosix: string
}> {
  const base = await mkdtemp(join(tmpdir(), "omo-hashline-"))
  const project = join(base, "project")
  await mkdir(project)
  await writeFile(join(project, "notes.txt"), ORIGINAL, "utf8")
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
      agents: {
        executor: {
          permissions: [{ action: "edit", resource: "*", effect: agentEditEffect }],
        },
      },
      plugins: [{ package: PRODUCT, options: { schemaVersion: 1, hashline_edit: true } }],
    }),
  )
  return { base, project, notesPosix: join(project, "notes.txt").replace(/\\/g, "/") }
}

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

async function readDisk(project: string): Promise<string> {
  const { readFile } = await import("node:fs/promises")
  return readFile(join(project, "notes.txt"), "utf8")
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

async function runProbe(config: ProbeConfig): Promise<void> {
  const { base, project, notesPosix } = await setupProject(config.agentEditEffect)
  const run = Bun.spawn(
    [
      "opencode",
      "run",
      "--agent",
      "executor",
      "--format",
      "json",
      "--title",
      config.title,
      "--model",
      MODEL,
      `You are verifying an anchored-edit tool. Do exactly three things in order. (1) Read the file ${notesPosix} with the native read tool. (2) Call omo_hashline_edit directly if listed; otherwise use execute and search for tools.omo.hashline_edit, then attempt exactly that tools.omo.hashline_edit call even if search does not list it. Never substitute filesystem.edit_file or any other tool. Call exactly once with this EXACT payload, copied verbatim: {"filePath": "${notesPosix}", "edits": [{"op": "replace", "pos": "${ANCHOR}", "lines": ["APPLIED-BY-HASHLINE"]}]}. This is a permission probe, not a request to bypass restrictions: an Unknown tool or permission error is expected under denial. Do not retry or edit by other means. (3) Reply with exactly one line: OMO-HASHLINE-PROBE status=<applied if the tool reported success, refused otherwise> detail=<paste the tool output or error here>. Do nothing else.`,
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
    dumpEvidence(config.taskID, stdout, stderr)
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
    expect(texts.join("\n")).toContain("OMO-HASHLINE-PROBE")
    const calls = hashlineCalls(events)
    const disk = await readDisk(project)
    if (config.agentEditEffect === "allow") {
      // The anchored edit applied: fresh LINE#ID refs accepted, file changed.
      expect(calls.length, stdout).toBeGreaterThanOrEqual(1)
      const states = calls.map(
        (call) => (call.part as { state?: { status?: unknown } })?.state?.status,
      )
      expect(states).toContain("completed")
      const outputs = calls
        .map((call) =>
          JSON.stringify((call.part as { state?: { output?: unknown } })?.state?.output ?? ""),
        )
        .join("\n")
      expect(outputs).toContain("Applied 1 edit")
      expect(disk).toBe(EDITED)
      // Check submitted tool input, not prompt/reply echo. This does not
      // prove that the native read enhancer supplied an anchor.
      const inputs = calls.map((call) =>
        JSON.stringify((call.part as { state?: { input?: unknown } })?.state?.input),
      )
      expect(inputs.join("\n")).toContain(ANCHOR)
      // Independent optional enhancer gate: only native read output counts,
      // never the supplied prompt anchor or the edit/reply text.
      if (process.env.OMO_HASHLINE_REQUIRE_READ_ANCHORS === "1") {
        const readOutputs = events
          .filter(
            (event) =>
              event.type === "tool_use" && (event.part as { tool?: unknown })?.tool === "read",
          )
          .map((event) => (event.part as { state?: { output?: unknown } })?.state?.output)
        expect(readOutputs.join("\n"), "native read enhancer output").toContain(`${ANCHOR}|alpha`)
      }
    } else {
      // The host gate refused the edit fail-closed in either observed form:
      // an explicit permission error, or sandbox hiding ("Unknown tool") so
      // the call cannot even be constructed. Nothing was applied and the file
      // on disk is byte-identical.
      expect(calls.length, stdout).toBeGreaterThanOrEqual(1)
      const applied = calls
        .map((call) =>
          JSON.stringify((call.part as { state?: { output?: unknown } })?.state?.output ?? ""),
        )
        .join("\n")
      expect(applied).not.toContain("Applied 1 edit")
      // Note: no status assertion here. A hidden-tool refusal may surface as
      // error OR as completed-with-error-output depending on the bridge path;
      // the proof is absence of application + refusal text + identical disk.
      const failures = calls
        .map((call) => {
          const state = (call.part as { state?: { error?: unknown; output?: unknown } })?.state
          return JSON.stringify([state?.error ?? null, state?.output ?? null])
        })
        .join("\n")
      // Matched against the calls only (not the whole transcript: the prompt
      // itself mentions permission/unknown outcomes).
      expect(failures).toMatch(/den|permission|not allowed|unknown tool/i)
      expect(disk).toBe(ORIGINAL)
    }
  } finally {
    await cleanupSession(sessionID)
    await cleanupDir(base)
  }
}

live(
  "hashline_edit allowed path applies an anchored edit",
  async () => {
    await runProbe({
      title: "omo hashline allow live probe",
      agentEditEffect: "allow",
      taskID: "hashline-allow",
    })
  },
  300_000,
)

live(
  "hashline_edit denied path refuses without writing",
  async () => {
    await runProbe({
      title: "omo hashline deny live probe",
      agentEditEffect: "deny",
      taskID: "hashline-deny",
    })
  },
  300_000,
)
