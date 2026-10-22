import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Opt-in live proof of model-driven parent/child delegation through the
// plugin's own `omo_delegate` tool (permission `subagent`).
//
// Requires OMO_LIVE=1 AND runs against the caller's managed host service
// (no `--standalone`): standalone servers own an empty database and see zero
// routable models — live credentials live in the host database, the free tier
// answers 403 outside the managed app, and copying the real database
// (~24 GB) into a sandbox is not viable. The probe therefore creates two
// real sessions (parent + child, titled below) in the caller's host and
// leaves them for manual cleanup. No global config is modified; the probe
// project is a temp dir removed afterwards.
//
// Model: OMO_LIVE_MODEL or the free default (works from the managed app).
// Observed 2026-10-07: parent ses_ee99200d5ffehFOEAvt4anyx6u
// (legacy omo-orchestrator, outcome succeeded, cost 0) delegated taskID `pc-live-1`
// to child ses_ee991e4a6ffeovnhfxuJ6q9sw6 (legacy omo-explore, outcome succeeded,
// parentID = parent, omo.depth 1, matching omo.attemptID) and echoed
// OMO-CHILD-OK verbatim; `opencode run` exit 0.
const live = process.env.OMO_LIVE === "1" ? test : test.skip
const MODEL = process.env.OMO_LIVE_MODEL ?? "opencode/deepseek-v4.1-flash-free"
const PRODUCT = "C:/Users/airshakur88/Documents/GitHub/OmO/hallaxius/omo"

live(
  "model-driven parent runs two explore children through omo_parallel",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "omo-par-live-"))
    const project = join(base, "project")
    await mkdir(project)
    await writeFile(
      join(project, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: MODEL,
        permission: { subagent: { "*": "allow" } },
        permissions: [{ action: "subagent", resource: "*", effect: "allow" }],
        plugins: [{ package: PRODUCT, options: { schemaVersion: 1 } }],
      }),
    )
    const run = Bun.spawn(
      [
        "opencode",
        "run",
        "--agent",
        "orchestrator",
        "--format",
        "json",
        "--title",
        "omo parallel live probe",
        "--model",
        MODEL,
        "Use the omo_parallel tool exactly once with a tasks array of exactly two entries: taskID pc-par-1 with prompt 'Reply with exactly OMO-PAR-ONE and nothing else', and taskID pc-par-2 with prompt 'Reply with exactly OMO-PAR-TWO and nothing else'. Both entries use route kind agent id explore and background false. After the tool returns, your final text response must contain the exact strings OMO-PAR-ONE and OMO-PAR-TWO. Do not output the raw tool-result JSON as your response.",
      ],
      { cwd: project, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ])
    try {
      expect(exit, `${stderr}\n${stdout}`).toBe(0)
      const events = stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
      const parentID = events[0]?.sessionID as string | undefined
      expect(parentID, stdout).toBeString()
      // Form-agnostic: newer hosts (v2.0.32 observed) surface plugin tools
      // through the code-mode `execute` wrapper — tool_use events carry
      // part.tool === "execute" with part.state.input.code naming
      // `tools.omo.parallel(...)` — while older hosts expose the native name.
      const parallelCalls = events.filter(
        (event) =>
          event.type === "tool_use" &&
          (event.part?.tool === "omo_parallel" ||
            JSON.stringify(event.part?.state?.input ?? "").includes("omo.parallel(")),
      )
      expect(parallelCalls, stdout).toHaveLength(1)
      const rawOutput = parallelCalls[0].part.state.output ?? ""
      const parsedOutput = typeof rawOutput === "string" ? JSON.parse(rawOutput) : rawOutput
      // Foreground batch: the tool settles only after BOTH children completed.
      expect(Array.isArray(parsedOutput), JSON.stringify(parsedOutput)).toBe(true)
      const handles = parsedOutput as { sessionID?: string; state?: string }[]
      expect(handles).toHaveLength(2)
      expect(handles.every((handle) => handle.state === "completed")).toBe(true)
      const childIDs = handles.map((handle) => handle.sessionID)
      expect(new Set(childIDs).size, JSON.stringify(childIDs)).toBe(2)
      const texts = events.filter((event) => event.type === "text").map((event) => event.part.text)
      expect(texts.join("\n")).toContain("OMO-PAR-ONE")
      expect(texts.join("\n")).toContain("OMO-PAR-TWO")
      // Host-observed linkage for both children, including the declared taskIDs
      // (order-agnostic: Promise.all preserves input order, but the proof must
      // not depend on it).
      const seenTaskIDs: string[] = []
      for (const [index, childID] of childIDs.entries()) {
        expect(childID, `child ${index}`).toBeString()
        const api = Bun.spawn(["opencode", "api", "get", `/api/session/${childID}`], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const [apiOut, apiErr, apiExit] = await Promise.all([
          new Response(api.stdout).text(),
          new Response(api.stderr).text(),
          api.exited,
        ])
        expect(apiExit, apiErr).toBe(0)
        const child = JSON.parse(apiOut).data
        expect(child.parentID).toBe(parentID)
        expect(child.agent).toBe("explore")
        expect(child.outcome).toBe("succeeded")
        expect(child.metadata?.["omo.parentSessionID"], `child ${index}`).toBe(parentID)
        const taskID = child.metadata?.["omo.taskID"]
        expect(["pc-par-1", "pc-par-2"], `child ${index}`).toContain(taskID)
        seenTaskIDs.push(taskID)
      }
      expect(seenTaskIDs.sort()).toEqual(["pc-par-1", "pc-par-2"])
    } finally {
      // Best-effort temp cleanup AFTER all assertions: the managed host
      // keeps the plugin SQLite handles for the probe project open, so rm
      // fails EBUSY on Windows while the service lives; never fail the proof.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await rm(base, { recursive: true, force: true })
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    }
  },
  300_000,
)

live(
  "model-driven parent delegates to explore child and echoes its reply",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "omo-pc-live-"))
    const project = join(base, "project")
    await mkdir(project)
    await writeFile(
      join(project, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: MODEL,
        permission: { subagent: { "*": "allow" } },
        permissions: [{ action: "subagent", resource: "*", effect: "allow" }],
        plugins: [{ package: PRODUCT, options: { schemaVersion: 1 } }],
      }),
    )
    const run = Bun.spawn(
      [
        "opencode",
        "run",
        "--agent",
        "orchestrator",
        "--format",
        "json",
        "--title",
        "omo parent-child live probe",
        "--model",
        MODEL,
        "Use the omo_delegate tool exactly once with taskID pc-live-1, route kind agent id explore, background false, and prompt 'Reply with exactly OMO-CHILD-OK and nothing else'. After the tool returns, your final text response must contain the exact string OMO-CHILD-OK on its own line. Do not output the raw tool-result JSON as your response.",
      ],
      { cwd: project, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ])
    try {
      expect(exit, `${stderr}\n${stdout}`).toBe(0)
      const events = stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
      const parentID = events[0]?.sessionID as string | undefined
      expect(parentID, stdout).toBeString()
      const delegateCalls = events.filter(
        (event) =>
          event.type === "tool_use" &&
          (event.part?.tool === "omo_delegate" ||
            JSON.stringify(event.part?.state?.input ?? "").includes("omo.delegate(")),
      )
      expect(delegateCalls, stdout).toHaveLength(1)
      const rawOutput = delegateCalls[0].part.state.output ?? ""
      const parsedOutput = typeof rawOutput === "string" ? JSON.parse(rawOutput) : rawOutput
      const output = JSON.stringify(parsedOutput)
      expect(delegateCalls[0].part.state.status).toBe("completed")
      expect(parsedOutput.state).toBe("completed")
      const childID = /"sessionID":"([^"]+)"/.exec(output)?.[1]
      expect(childID, output).toBeString()
      const texts = events.filter((event) => event.type === "text").map((event) => event.part.text)
      expect(texts.join("\n")).toContain("OMO-CHILD-OK")
      // Host-observed linkage: the child record names the parent, the
      // delegated agent, a succeeded outcome and the delegation metadata.
      const api = Bun.spawn(["opencode", "api", "get", `/api/session/${childID}`], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [apiOut, apiErr, apiExit] = await Promise.all([
        new Response(api.stdout).text(),
        new Response(api.stderr).text(),
        api.exited,
      ])
      expect(apiExit, apiErr).toBe(0)
      const child = JSON.parse(apiOut).data
      expect(child.parentID).toBe(parentID)
      expect(child.agent).toBe("explore")
      expect(child.outcome).toBe("succeeded")
      expect(child.metadata?.["omo.parentSessionID"]).toBe(parentID)
      expect(child.metadata?.["omo.taskID"]).toBe("pc-live-1")
    } finally {
      // Best-effort temp cleanup AFTER all assertions: the managed host
      // keeps the plugin SQLite handles for the probe project open, so rm
      // fails EBUSY on Windows while the service lives; never fail the proof.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await rm(base, { recursive: true, force: true })
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    }
  },
  300_000,
)
