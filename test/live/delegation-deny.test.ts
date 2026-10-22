import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Opt-in live snapshot of inherited denial, in two layers (all observed,
// 2026-10-07):
// Layer 1 — visibility: with `agents.<child>.permissions: subagent * deny`
// the host hides every tool requiring the `subagent` permission, so the
// nested delegate tool is unknown to the child while `omo_team`
// (permission `task`, ADR-0012) stays visible and callable (runs pc-deny-2
// and pc-deny-7: child calls omo.team -> [], nested attempt -> "Unknown
// tool 'omo.delegate'", zero grandchild sessions).
// Layer 2 — authorization: with `subagent * ask` the nested tool stays
// visible, the call reaches `authorizeParent` (src/host/permissions.ts) and
// is refused fail-closed (`effect=ask`, "native task approval is
// required") before any grandchild session is created (run pc-deny-8:
// child legacy omo-executor calls native omo.delegate -> ask-denial, omo.team
// -> [], no grandchild in GET /api/session).
// This file pins layer 2 (the ask variant); layer 1 is recorded here and
// in the gate docs as observed host behavior.
//
// Requires OMO_LIVE=1 AND runs against the caller's managed host service
// (no `--standalone`): standalone servers own an empty database and see zero
// routable models. The probe creates two real sessions (parent + child,
// titled below) in the caller's host; the nested grandchild must NOT exist.
// The probe project is a temp dir removed afterwards; no global config is
// modified.
//
// Design notes (all observed, 2026-10-07):
// - Per-agent rules (`agents.<id>.permissions`) are appended after global
//   rules, and a custom subagent uses its own permissions, not a subset of
//   its parent's. The plugin's agent transform only appends edit/shell
//   denies for readonly profiles (src/agents/registry.ts), so a
//   config-provided `subagent * deny` stays effective. The parent
//   (legacy omo-orchestrator) keeps the global `subagent * allow` and can delegate.
// - The denied child was legacy omo-executor (not legacy omo-explore): the explore
//   consultation profile is scope-guarded and refused to call any tool in
//   run pc-deny-1 ("Result: DENIED", zero tool calls) — a prompt-obedience
//   artifact, not a permission outcome. The executor profile performs tool
//   calls as its normal job, so the denial is exercised for real.
const live = process.env.OMO_LIVE === "1" ? test : test.skip
const MODEL = process.env.OMO_LIVE_MODEL ?? "opencode/deepseek-v4.1-flash-free"
const PRODUCT = "C:/Users/airshakur88/Documents/GitHub/OmO/hallaxius/omo"

live(
  "subagent-deny child keeps omo_team but cannot nest delegation",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "omo-pc-deny-"))
    const project = join(base, "project")
    await mkdir(project)
    await writeFile(
      join(project, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: MODEL,
        permission: { subagent: { "*": "allow" } },
        permissions: [{ action: "subagent", resource: "*", effect: "allow" }],
        agents: {
          executor: {
            permissions: [{ action: "subagent", resource: "*", effect: "ask" }],
          },
        },
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
        "omo inherited-deny live probe",
        "--model",
        MODEL,
        "Your objective: verify team-coordination availability and delegation policy. Your tool list contains omo tools (native names like omo_delegate and omo_team) plus an execute tool whose code catalog exposes tools.omo.* paths. Prefer the native omo tools from your tool list; if one is unavailable, use the execute tool with the equivalent tools.omo.* call and record which path you used. Do exactly three things in order. (1) Call the team-list tool (native omo_team, or execute tools.omo.team with action list) with action list and no teamID; keep its output. (2) Use the delegate tool exactly once (native omo_delegate, or execute tools.omo.delegate) with taskID pc-deny-8, route kind agent id executor, background false, and prompt 'Your objective: verify team-coordination availability and delegation policy. Your tool list contains omo tools (native names like omo_delegate and omo_team) plus an execute tool whose code catalog exposes tools.omo.* paths. Prefer the native omo tools; if one is unavailable, use the execute tool with the equivalent tools.omo.* call and record which path you used. Do exactly three things in order. (1) Call the team-list tool from YOUR tool list (exact listed name) with action list and no teamID; keep its output. (2) Call the delegate tool from YOUR tool list (exact listed name, for example omo.delegate — use the exact listed spelling, never the execute tool) with taskID pc-deny-nested8, route kind agent id executor, background false, prompt Reply with exactly NESTED. Record whether it succeeds or fails and the exact error text, and do not retry with different tools. (3) Reply with exactly one line filled with YOUR values: OMO-DENY-PROBE team_list=<paste the team output here> nested=<succeed, or fail: paste the exact error here>.' (3) Reply with exactly: OMO-PARENT-REPORT team_path=<native|execute> team_list=<output> child=<child result verbatim>. Do nothing else: no other delegations, no verification calls.",
      ],
      { cwd: project, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ])
    try {
      // The model run finished; parse and assert before touching the disk.
      // Best-effort raw evidence for forensics (never fails the proof).
      try {
        const { mkdirSync, writeFileSync } = await import("node:fs")
        const evDir = join(tmpdir(), "opencode", "omo-pc-deny-evidence")
        mkdirSync(evDir, { recursive: true })
        writeFileSync(join(evDir, `run-${Date.now()}.stdout.jsonl`), stdout, "utf8")
      } catch {
        // Evidence dump is forensic only; ignore failures.
      }
      expect(exit, `${stderr}\n${stdout}`).toBe(0)
      const events = stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
      const parentID = events[0]?.sessionID as string | undefined
      expect(parentID, stdout).toBeString()
      const delegateCalls = events.filter((event) => {
        if (event.type !== "tool_use") return false
        const blob = JSON.stringify(event.part?.state?.input ?? "")
        if (!blob.includes("pc-deny-8")) return false
        const name = String(event.part?.tool ?? "")
        return /delegat/i.test(name) || /delegat/i.test(blob)
      })
      expect(delegateCalls, stdout).toHaveLength(1)
      expect(delegateCalls[0].part.state.status).toBe("completed")
      const raw = delegateCalls[0].part.state.output as unknown
      const handle = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        attemptID?: string
        sessionID?: string
        state?: string
      }
      expect(handle.state).toBe("completed")
      const childID = handle.sessionID
      expect(childID, JSON.stringify(handle)).toBeString()
      // The child ran to completion. Its own transcript (fetched via session
      // export — the parent only echoes the handle, not the child text) must
      // carry the probe line with the authorization-layer denial.
      const texts = events.filter((event) => event.type === "text").map((event) => event.part.text)
      const joined = texts.join("\n")
      expect(joined).toContain("OMO-PARENT-REPORT")
      const { mkdirSync, writeFileSync } = await import("node:fs")
      const evDir = join(tmpdir(), "opencode", "omo-pc-deny-evidence")
      mkdirSync(evDir, { recursive: true })
      const childExport = Bun.spawn(["opencode", "session", "export", childID as string], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exportOut, exportErr, exportExit] = await Promise.all([
        new Response(childExport.stdout).text(),
        new Response(childExport.stderr).text(),
        childExport.exited,
      ])
      expect(exportExit, exportErr).toBe(0)
      writeFileSync(join(evDir, "child-pcdeny8-export.json"), exportOut, "utf8")
      expect(exportOut).toContain("OMO-DENY-PROBE")
      expect(exportOut).toContain("team_list=[]")
      // Authorization-layer denial (src/host/permissions.ts authorizeParent):
      // the nested call reached the gate with effect=ask and was refused
      // before any grandchild session was created.
      expect(exportOut).toContain("effect=ask")
      expect(exportOut).toContain("native task approval is required")
      // The child must name the parent and run as the configured executor,
      // and succeeded (it reports the nested denial instead of crashing).
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
      expect(child.agent).toBe("executor")
      expect(child.outcome).toBe("succeeded")
      expect(child.metadata?.["omo.taskID"]).toBe("pc-deny-8")
      if (Array.isArray(child.children))
        expect(child.children, JSON.stringify(child)).toHaveLength(0)
    } finally {
      // Best-effort temp cleanup AFTER all assertions: the spawned host may
      // briefly hold the cwd handle on Windows (EBUSY); never fail the proof.
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
