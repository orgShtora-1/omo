import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Opt-in live proof of the dream/time reflection trigger on the caller's
// managed host service (same pattern as hashline-permission.test.ts).
//
// Requires OMO_LIVE=1 AND runs against the caller's managed host service.
// The probe uses one session S across two `opencode run` invocations:
//
//   run1 (new session S): the memory context hook observes the turn and
//     stamps activityAt (first observation never arms dreamDue). An explicit
//     memory_pipeline ingest with trigger "dream" must be REFUSED loudly
//     with dream-no-idle-gap BEFORE any mutation, and memory_reflection_state
//     must report dreamDue:false.
//
//   sleep >= idleMinutes (configured to 1) so the next observation gap is
//     satisfied.
//
//   run2 (--session S): the context hook observation arms dreamDue (>=1min
//     since activityAt), the explicit dream ingest now succeeds (queued:true,
//     flag consumed, dreamAt stamped), reserve/settle exercise the durable
//     queue lifecycle, and the final reflection_state shows dreamAt set with
//     dreamDue:false.
//
// The session is left for manual cleanup; the probe project is a temp dir
// removed afterwards (best-effort on Windows — the host keeps sqlite handles).

const live = process.env.OMO_LIVE === "1" ? test : test.skip
const MODEL = process.env.OMO_LIVE_MODEL ?? "opencode/deepseek-v4.1-flash-free"
const PRODUCT = "C:/Users/airshakur88/Documents/GitHub/OmO/hallaxius/omo"

type Event = Record<string, unknown>
type ToolState = { status?: unknown; output?: unknown; input?: unknown; error?: unknown }

function dumpEvidence(tag: string, stdout: string, stderr?: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs")
    fs.mkdirSync(join(tmpdir(), "opencode", "omo-hashline-evidence"), { recursive: true })
    fs.writeFileSync(
      join(tmpdir(), "opencode", "omo-hashline-evidence", `${tag}-${Date.now()}.stdout.jsonl`),
      stdout,
    )
    if (stderr !== undefined) {
      fs.writeFileSync(
        join(tmpdir(), "opencode", "omo-hashline-evidence", `${tag}-${Date.now()}.stderr.txt`),
        stderr,
      )
    }
  } catch {
    // Forensic evidence is best-effort; never fails the probe.
  }
}

async function cleanupSession(id: string): Promise<void> {
  try {
    const run = Bun.spawn(["opencode", "session", "delete", id], {
      stdout: "ignore",
      stderr: "ignore",
    })
    await run.exited
  } catch {
    // Best-effort only.
  }
}

async function cleanupDir(base: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(base, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
}

function parseEvents(stdout: string): Event[] {
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Event)
}

function isCallTo(event: Event, toolName: string): boolean {
  if (event.type !== "tool_use") return false
  const part = event.part as { tool?: unknown; state?: { input?: unknown } } | undefined
  if (part === undefined) return false
  const tool = typeof part.tool === "string" ? part.tool : ""
  const input = JSON.stringify(part.state?.input ?? "")
  return (
    tool === `omo_${toolName}` || tool === `omo.${toolName}` || input.includes(`omo.${toolName}`)
  )
}

function stateOf(event: Event): ToolState {
  const part = event.part as { state?: ToolState } | undefined
  return part?.state ?? {}
}

function textOf(events: Event[]): string {
  return events
    .filter((event) => event.type === "text")
    .map(
      (event) => ((event as { part?: { text?: unknown } }).part?.text as string | undefined) ?? "",
    )
    .join("\n")
}

// The model may call tools through the `execute` wrapper (Promise.allSettled
// arrays, escaped JSON strings) or directly; extract the LAST dream verdict
// fields tolerantly. The wrappers escape quotes as \" — both forms match.
function extractDream(outputText: string): { dreamDue: string; dreamAt: string } {
  const dues = [...outputText.matchAll(/\\?"dreamDue\\?":\s*(true|false)/g)]
  const ats = [...outputText.matchAll(/\\?"dreamAt\\?":\s*(null|\d+)/g)]
  const due = dues.at(-1)?.[1]
  const at = ats.at(-1)?.[1]
  if (due === undefined || at === undefined) {
    throw new Error(`dream fields not found in reflection state output: ${outputText}`)
  }
  return { dreamDue: due, dreamAt: at }
}

async function runOnce(
  project: string,
  title: string | undefined,
  prompt: string,
  session?: string,
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const args = ["opencode", "run", "--agent", "executor", "--format", "json", "--model", MODEL]
  if (title !== undefined) args.push("--title", title)
  if (session !== undefined) args.push("--session", session)
  args.push(prompt)
  const run = Bun.spawn(args, { cwd: project, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ])
  return { stdout, stderr, exit }
}

live(
  "dream/time reflection trigger refuses without idle gap and fires after it on the live host",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "omo-dream-live-"))
    const project = join(base, "project")
    await mkdir(project)
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
            permissions: [
              { action: "edit", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
            ],
          },
        },
        plugins: [
          {
            package: PRODUCT,
            options: {
              schemaVersion: 1,
              memory_enabled: true,
              memory_dream: { enabled: true, idleMinutes: 1, minHoursBetween: 24 },
            },
          },
        ],
      }),
    )

    let sessionID: string | undefined
    try {
      // ---- run1: first observation stamps activityAt; dream ingest must refuse.
      const run1 = await runOnce(
        project,
        "omo dream live probe run1",
        [
          "You are executing a scripted tool probe. Do exactly these steps, nothing else.",
          "",
          "Step 1: Call the tool named omo_memory_pipeline (it may appear as omo.memory_pipeline) with EXACTLY this input:",
          '{"action":"ingest","text":"dream probe observation one","trigger":"dream"}',
          "This call is EXPECTED TO FAIL with an error mentioning dream-no-idle-gap. That failure is the correct outcome. Do not retry it and do not change the trigger.",
          "",
          "Step 2: Call the tool named omo_memory_reflection_state (it may appear as omo.memory_reflection_state) with EXACTLY this input:",
          "{}",
          "",
          "Then reply with EXACTLY these three lines and nothing else:",
          "DREAM-STEP1 <verbatim error or output text of step 1>",
          "DREAM-STEP2 <verbatim output text of step 2>",
          "OMO-DREAM-P1 status=<refused|unexpected> detail=<one short sentence>",
        ].join("\n"),
      )
      dumpEvidence("dream-run1", run1.stdout, run1.stderr)
      expect(run1.exit, `${run1.stderr}\n${run1.stdout}`).toBe(0)
      const events1 = parseEvents(run1.stdout)
      sessionID = events1[0]?.sessionID as string | undefined
      expect(sessionID, run1.stdout).toBeString()

      const texts1 = textOf(events1)
      expect(texts1, run1.stdout).toContain("OMO-DREAM-P1")

      const pipeline1 = events1.filter((event) => isCallTo(event, "memory_pipeline"))
      expect(pipeline1.length, run1.stdout).toBeGreaterThanOrEqual(1)
      const refusal = pipeline1
        .map((event) =>
          JSON.stringify([stateOf(event).error ?? null, stateOf(event).output ?? null]),
        )
        .join("\n")
      expect(refusal, run1.stdout).toMatch(/dream-no-idle-gap/i)
      expect(refusal, run1.stdout).not.toMatch(/queued\\?":\s*true/i)

      const state1 = events1.filter((event) => isCallTo(event, "memory_reflection_state"))
      expect(state1.length, run1.stdout).toBeGreaterThanOrEqual(1)
      const stateOut1 = state1
        .map((event) => stateOf(event).output)
        .filter((output): output is string => typeof output === "string")
        .join("\n")
      const dream1 = extractDream(stateOut1)
      expect(dream1.dreamDue, stateOut1).toBe("false")
      expect(dream1.dreamAt, stateOut1).toBe("null")

      // ---- idle gap: configured idleMinutes is 1, wait comfortably past it.
      await new Promise((resolve) => setTimeout(resolve, 70_000))

      // ---- run2 (same session): observation arms dreamDue; dream ingest fires.
      const run2 = await runOnce(
        project,
        undefined,
        [
          "You are executing a scripted tool probe. Do exactly these steps, in order, nothing else.",
          "",
          "Step 1: Call omo_memory_pipeline with EXACTLY this input:",
          '{"action":"ingest","text":"dream probe ingest","trigger":"dream"}',
          'It should SUCCEED with output containing "queued":true. If it fails with dream-no-idle-gap, reply with the single line OMO-DREAM-P2 status=not-armed detail=<the error> and stop.',
          "",
          "Step 2: Call omo_memory_pipeline with EXACTLY this input:",
          '{"action":"reserve"}',
          "Note the run identifier in its output JSON (the runID field if present, otherwise id).",
          "",
          "Step 3: Call omo_memory_pipeline with EXACTLY this input, replacing <RUNID> with the identifier from step 2:",
          '{"action":"settle","runID":"<RUNID>","outcome":"merged"}',
          "",
          "Step 4: Call omo_memory_reflection_state with EXACTLY this input:",
          "{}",
          "",
          "Then reply with EXACTLY these five lines and nothing else:",
          "DREAM-STEP1 <verbatim output of step 1>",
          "DREAM-STEP2 <verbatim output of step 2>",
          "DREAM-STEP3 <verbatim output of step 3>",
          "DREAM-STEP4 <verbatim output of step 4>",
          "OMO-DREAM-P2 status=<ok|not-armed> detail=<one short sentence>",
        ].join("\n"),
        sessionID,
      )
      dumpEvidence("dream-run2", run2.stdout, run2.stderr)
      expect(run2.exit, `${run2.stderr}\n${run2.stdout}`).toBe(0)
      const events2 = parseEvents(run2.stdout)
      expect(events2[0]?.sessionID, run2.stdout).toBe(sessionID)

      const texts2 = textOf(events2)
      expect(texts2, run2.stdout).toContain("OMO-DREAM-P2")
      expect(texts2, run2.stdout).not.toContain("status=not-armed")

      const pipeline2 = events2.filter((event) => isCallTo(event, "memory_pipeline"))
      expect(pipeline2.length, run2.stdout).toBeGreaterThanOrEqual(3)
      const outputs2 = pipeline2
        .map((event) => {
          const state = stateOf(event)
          const input = JSON.stringify(state.input ?? {})
          return `${input} => ${JSON.stringify([state.status ?? null, state.error ?? null, state.output ?? null])}`
        })
        .join("\n")
      // The dream ingest is identified by its tool receipt, not by the input
      // encoding (the free model may pass a JS object literal through the
      // execute wrapper): only ingest answers {"queued":true}, and only a
      // dream-triggered enqueue sets dreamAt, asserted on the state below.
      const ingest2 = pipeline2.filter((event) => {
        const state = stateOf(event)
        const haystack = JSON.stringify([state.output ?? null, state.error ?? null])
        return /queued\\?":\s*true/i.test(haystack)
      })
      expect(ingest2.length, outputs2).toBeGreaterThanOrEqual(1)

      const state2 = events2.filter((event) => isCallTo(event, "memory_reflection_state"))
      expect(state2.length, run2.stdout).toBeGreaterThanOrEqual(1)
      const stateOut2 = state2
        .map((event) => stateOf(event).output)
        .filter((output): output is string => typeof output === "string")
        .join("\n")
      const dream2 = extractDream(stateOut2)
      expect(dream2.dreamDue, stateOut2).toBe("false")
      expect(dream2.dreamAt, stateOut2).toMatch(/^\d+$/)
    } finally {
      if (sessionID !== undefined) await cleanupSession(sessionID)
      await cleanupDir(base)
    }
  },
  600_000,
)
