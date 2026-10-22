import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Opt-in live proof of the teams runtime on the caller's managed host:
//   (A) the parent creates a team whose members are the parent itself and a
//       real delegated child, then drives task_create -> claim -> complete ->
//       send -> status through the omo_team tool;
//   (B) mailbox context injection: the child, continued via omo_delegate,
//       quotes the unread body that only the injected <team_mailbox> block
//       can carry (the probe never calls read/ack, so the mail stays unread);
//   (C) access denial: a fresh non-member child receives the omo_team body's
//       member-inactive refusal when it asks for status (the execute.before
//       gate deliberately lets status through; the tool body is authoritative);
//   (D) idle wake: after the child's next idle event the plugin prompts it
//       with the mailbox block, observed as a user message starting with
//       `<team_mailbox` in the child's session history (API polling).
//
// Requires OMO_LIVE=1 and runs against the caller's managed host service
// (no --standalone): standalone servers own an empty database and see zero
// routable models — live credentials live in the host database. The probe
// project is a temp dir removed afterwards, best effort on Windows: the
// managed host keeps the plugin's SQLite handles open (EBUSY), so cleanup
// retries briefly and otherwise leaves the temp dir behind.

const live = process.env.OMO_LIVE === "1" ? test : test.skip

const MODEL = process.env.OMO_LIVE_MODEL ?? "opencode/deepseek-v4.1-flash-free"
const PRODUCT = "C:/Users/airshakur88/Documents/GitHub/OmO/hallaxius/omo"

function dumpEvidence(tag: string, stdout: string, stderr?: string): void {
  try {
    const fs = require("node:fs")
    const dir = join(tmpdir(), "opencode", "omo-hashline-evidence")
    fs.mkdirSync(dir, { recursive: true })
    const stamp = Date.now()
    fs.writeFileSync(join(dir, `${tag}-${stamp}.stdout.jsonl`), stdout)
    if (stderr !== undefined) fs.writeFileSync(join(dir, `${tag}-${stamp}.stderr.txt`), stderr)
  } catch {
    // Forensic dump is best effort only.
  }
}

async function cleanupSession(sessionID: string | undefined): Promise<void> {
  if (sessionID === undefined || sessionID === "") return
  try {
    const run = Bun.spawn(["opencode", "session", "delete", sessionID], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await run.exited
  } catch {
    // Session deletion is best effort; the host keeps its own records.
  }
}

async function cleanupDir(base: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(base, { recursive: true, force: true })
      return
    } catch {
      // Windows: the managed host keeps the plugin's SQLite handles open
      // (EBUSY); retry briefly, then leave the temp dir behind.
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
}

interface RunResult {
  stdout: string
  stderr: string
  exit: number
}

async function runOnce(
  project: string,
  args: { title?: string; session?: string; prompt: string },
): Promise<RunResult> {
  const argv = ["opencode", "run", "--agent", "executor", "--format", "json"]
  if (args.title !== undefined) argv.push("--title", args.title)
  if (args.session !== undefined) argv.push("--session", args.session)
  argv.push("--model", MODEL, args.prompt)
  const run = Bun.spawn(argv, { cwd: project, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ])
  return { stdout, stderr, exit }
}

type Event = Record<string, unknown>

function parseEvents(stdout: string): Event[] {
  return stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Event)
}

function partOf(event: Event): Record<string, unknown> {
  const part = event.part
  return typeof part === "object" && part !== null ? (part as Record<string, unknown>) : {}
}

function stateOf(event: Event): Record<string, unknown> {
  const state = partOf(event).state
  return typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {}
}

function calls(events: Event[], needle: string): Event[] {
  return events.filter((event) => {
    if (event.type !== "tool_use") return false
    const tool = partOf(event).tool
    if (tool === `omo_${needle}` || tool === `omo.${needle}`) return true
    // The model may route through the execute wrapper; the receipt then
    // carries the invoked source, which mentions tools.omo.<needle>(.
    return JSON.stringify(stateOf(event).input ?? "").includes(`omo.${needle}(`)
  })
}

function teamInvocationCount(events: Event[]): number {
  let count = 0
  for (const event of events) {
    if (event.type !== "tool_use") continue
    const tool = partOf(event).tool
    if (tool === "omo_team" || tool === "omo.team") {
      count += 1
      continue
    }
    // The model may batch several omo.team invocations inside one execute
    // wrapper call; count each invocation, not each wrapper.
    const blob = JSON.stringify([
      (event as Record<string, unknown>).metadata ?? null,
      stateOf(event).input ?? "",
      stateOf(event).output ?? "",
    ])
    const hits = blob.match(/omo\.team\s*\(/g)
    if (hits !== null) count += hits.length
  }
  return count
}

function dumpOf(event: Event): string {
  const state = stateOf(event)
  return JSON.stringify([state.output ?? null, state.error ?? null])
}

function textsOf(events: Event[]): string {
  return events
    .filter((event) => event.type === "text")
    .map((event) => String(partOf(event).text ?? ""))
    .join("\n")
}

/**
 * Session ids reach us pretty-printed (`"sessionID": "ses_..."`), compact
 * (`"sessionID":"ses_..."`), escaped inside a stringified receipt
 * (`\"sessionID\": \"ses_...\"`) or as a JS literal in wrapper code
 * (`sessionID: "ses_..."`), so all four shapes are matched.
 */
function extractSessionID(blob: string): string | undefined {
  const direct = /"sessionID"\s*:\s*"([^"]+)"/.exec(blob)?.[1]
  if (direct !== undefined) return direct
  const escaped = /\\?"sessionID\\?"\s*:\s*\\?"([^"\\]+)/.exec(blob)?.[1]
  if (escaped !== undefined) return escaped
  return /(?:^|[^a-zA-Z])sessionID\s*:\s*\\?"([^"\\]+)/.exec(blob)?.[1]
}

/**
 * Team action of a receipt. Inputs reach us as JSON (direct call), as an
 * escaped JSON string (wrapper output), or as a JS literal in wrapper code
 * (unquoted key), so all three shapes are matched.
 */
function actionOf(call: Event): string | undefined {
  const input = JSON.stringify(stateOf(call).input ?? "")
  const direct = /"action"\s*:\s*"([a-z_]+)"/.exec(input)?.[1]
  if (direct !== undefined) return direct
  const escaped = /\\?"action\\?"\s*:\s*\\?"([a-z_]+)/.exec(input)?.[1]
  if (escaped !== undefined) return escaped
  return /\baction\s*:\s*\\?"?([a-z_]+)/.exec(input)?.[1]
}

async function fetchMessages(sessionID: string): Promise<Array<Record<string, unknown>>> {
  const api = Bun.spawn(["opencode", "api", "get", `/api/session/${sessionID}/message`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, , exit] = await Promise.all([
    new Response(api.stdout).text(),
    new Response(api.stderr).text(),
    api.exited,
  ])
  if (exit !== 0) return []
  const parsed = JSON.parse(out) as { data?: unknown }
  return Array.isArray(parsed.data) ? (parsed.data as Array<Record<string, unknown>>) : []
}

function messageText(message: Record<string, unknown>): string {
  const direct = message.text
  if (typeof direct === "string" && direct !== "") return direct
  const content = message.content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text"
        ? String((part as Record<string, unknown>).text ?? "")
        : "",
    )
    .filter((text) => text !== "")
    .join(" ")
}

live(
  "teams runtime: member child, mailbox injection and non-member denial",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "omo-teams-live-"))
    const project = join(base, "project")
    await mkdir(project)
    await writeFile(
      join(project, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: MODEL,
        permission: {
          subagent: { "*": "allow" },
          task: { "*": "allow" },
          edit: { "*": "allow" },
          read: { "*": "allow" },
        },
        permissions: [
          { action: "subagent", resource: "*", effect: "allow" },
          { action: "task", resource: "*", effect: "allow" },
          { action: "edit", resource: "*", effect: "allow" },
          { action: "read", resource: "*", effect: "allow" },
        ],
        agents: {
          executor: {
            permissions: [
              { action: "subagent", resource: "*", effect: "allow" },
              { action: "task", resource: "*", effect: "allow" },
              { action: "edit", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
            ],
          },
        },
        plugins: [{ package: PRODUCT, options: { schemaVersion: 1 } }],
      }),
    )

    let parentID: string | undefined
    let childID: string | undefined
    let secondChildID: string | undefined
    try {
      // ---- Run 1: materialize the child the team will accept as a member.
      const run1 = await runOnce(project, {
        title: "omo teams live probe",
        prompt:
          "Use the omo_delegate tool exactly once with taskID teams-live-1, route kind agent id executor, background false, " +
          "and prompt 'Reply with exactly CHILD-READY and nothing else'. Do not use any other tool. " +
          "After the tool returns, your final text response must be exactly one line: TEAM-P0 status=ok",
      })
      dumpEvidence("teams-run1", run1.stdout, run1.stderr)
      expect(run1.exit, `${run1.stderr}\n${run1.stdout}`).toBe(0)
      const events1 = parseEvents(run1.stdout)
      parentID = events1[0]?.sessionID as string | undefined
      expect(parentID, run1.stdout).toBeString()
      const delegate1 = calls(events1, "delegate")
      // Bootstrap only: the exactly-once delegation discipline is pinned by
      // test/live/delegation.test.ts; here any completed delegate that
      // materializes the child is enough (the free model occasionally
      // retries the call).
      expect(delegate1.length, run1.stdout).toBeGreaterThanOrEqual(1)
      const delegateCall =
        delegate1.find((candidate) => stateOf(candidate).status === "completed") ?? delegate1[0]
      expect(delegateCall, run1.stdout).toBeTruthy()
      expect(stateOf(delegateCall as Event).status).toBe("completed")
      childID = extractSessionID(dumpOf(delegateCall as Event))
      expect(childID, dumpOf(delegateCall as Event)).toBeString()
      expect(textsOf(events1)).toContain("TEAM-P0")

      // ---- Run 2: parent drives the full member workflow, mail stays unread.
      const run2 = await runOnce(project, {
        session: parentID,
        prompt:
          `You lead session ${parentID} and session ${childID} is a child of yours. ` +
          "Call the omo_team tool (use it directly if it is listed; otherwise through the execute tool by searching for omo.team) " +
          "EXACTLY once per step, in this order:\n" +
          `1. {"action":"create","teamID":"live-team","members":["${parentID}","${childID}"],"tasks":[]}\n` +
          '2. {"action":"task_create","teamID":"live-team","taskID":"t1"}\n' +
          '3. {"action":"claim","teamID":"live-team","taskID":"t1"} — from its result copy the claim id value\n' +
          '4. {"action":"complete","teamID":"live-team","taskID":"t1","claimID":"<the claim id from step 3>","evidence":["teams-live-probe"]}\n' +
          `5. {"action":"send","teamID":"live-team","recipientID":"${childID}","dedupKey":"c-mail-1","body":"TEAM-MAIL-C-7f3k"}\n` +
          '6. {"action":"status","teamID":"live-team"}\n' +
          "Never call the read or ack actions — the mail must stay unread. " +
          "After all six calls return, your final text response must be exactly one line: TEAM-P1 status=<ok|failed>",
      })
      dumpEvidence("teams-run2", run2.stdout, run2.stderr)
      expect(run2.exit, `${run2.stderr}\n${run2.stdout}`).toBe(0)
      const events2 = parseEvents(run2.stdout)
      const teamCalls = calls(events2, "team")
      expect(teamCalls.length, run2.stdout).toBeGreaterThanOrEqual(6)
      const actions = teamCalls.map((call) => actionOf(call))
      // The unread mail is the fixture for phases B and D: reading or
      // acknowledging it here would invalidate both.
      const forbidden = actions.filter((action) => action === "read" || action === "ack")
      expect(forbidden, JSON.stringify(actions)).toHaveLength(0)
      // The free model sometimes retries a refused step with corrected
      // arguments (observed: create without tasks, retried with tasks:[]);
      // the receipt that matters is the one the store accepted.
      const receiptOf = (action: string): string => {
        const matches = teamCalls.filter((candidate) => actionOf(candidate) === action)
        expect(
          matches.length,
          `no ${action} receipt among ${JSON.stringify(actions)}`,
        ).toBeGreaterThan(0)
        const succeeded = matches.find(
          (candidate) =>
            !/invalid-input|leader-required|foreign-member|member-inactive|team-required|unknown-team/.test(
              dumpOf(candidate),
            ),
        )
        return dumpOf((succeeded ?? matches.pop()) as Event)
      }
      expect(receiptOf("create")).toMatch(/live-team/)
      expect(receiptOf("create")).toMatch(/\\?"members\\?"/)
      expect(receiptOf("claim")).toMatch(/\\?"id\\?":\s*\\?"[0-9a-f-]{8,}/)
      expect(receiptOf("complete")).toContain("t1")
      expect(receiptOf("send")).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/)
      expect(receiptOf("status")).toMatch(/\\?"members\\?"/)
      expect(textsOf(events2)).toContain("TEAM-P1")

      // ---- Run 3: mailbox injection through the child, denial through a stranger.
      const run3 = await runOnce(project, {
        session: parentID,
        prompt:
          "Make exactly two omo_delegate calls, in this order, each with route kind agent id executor and background false:\n" +
          `1. taskID teams-live-2, sessionID ${childID}, prompt: 'Look at the team mailbox block in your context. ` +
          "Reply with exactly MAILBODY=<the body text of the unread team message addressed to you> and nothing else.'\n" +
          "2. taskID teams-live-3 (a brand new child session), prompt: 'Call the omo_team tool once with " +
          '{"action":"status","teamID":"live-team"}. If that tool is not directly listed in your tools, ' +
          "use the execute tool and first run search with query 'omo.team' to discover the team tool path, " +
          "then call it through execute. Then reply with exactly DENIED:<the exact error text you received> " +
          "and nothing else. Do not call any other team action.'\n" +
          "After both children return, echo each child's reply in order. Your final text response must be exactly two lines:\n" +
          "MAIL=<child one reply>\n" +
          "DENY=<child two reply>",
      })
      dumpEvidence("teams-run3", run3.stdout, run3.stderr)
      expect(run3.exit, `${run3.stderr}\n${run3.stdout}`).toBe(0)
      const events3 = parseEvents(run3.stdout)
      const delegate3 = calls(events3, "delegate")
      expect(delegate3.length, run3.stdout).toBe(2)
      secondChildID = extractSessionID(dumpOf(delegate3[1] as Event))
      const texts3 = textsOf(events3)
      // Phase B: the body only exists inside the injected <team_mailbox> block,
      // so the child quoting it proves the context hook end to end.
      expect(texts3, run3.stdout).toContain("MAILBODY=TEAM-MAIL-C-7f3k")
      // Phase C: the gate lets status through for anyone; the omo_team body
      // refuses non-members. The child can only have learned the term from
      // the tool's refusal, never from the delegation prompt.
      expect(texts3, run3.stdout).toContain("DENIED:")
      expect(texts3, run3.stdout).toContain("member-inactive")
    } finally {
      await cleanupSession(parentID)
      await cleanupSession(childID)
      await cleanupSession(secondChildID)
      await cleanupDir(base)
    }
  },
  900_000,
)

// The idle wake is its own test because it is the one teams-runtime behaviour
// that does NOT reproduce on the caller's managed host today. The host SDK
// declares session.idle with data.sessionID (client types.d.ts) and the plugin
// subscribes with the matching shape, yet no <team_mailbox> wake prompt has
// been observed on the managed service — neither for delegated children nor
// for top-level sessions — while the tool, the execute.before gate, the
// context injection and the non-member denial all work there. The wake handler
// swallows its own errors by design and the managed host refuses to load
// third-party diagnostic plugins, so whether the event is not emitted or the
// prompt fails stays open. This test pins the expected behaviour; it fails
// live against the managed host until that question is resolved.
live(
  "teams runtime: idle session wakes with the mailbox block",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "omo-teams-wake-"))
    const project = join(base, "project")
    await mkdir(project)
    await writeFile(
      join(project, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: MODEL,
        permission: {
          subagent: { "*": "allow" },
          task: { "*": "allow" },
          edit: { "*": "allow" },
          read: { "*": "allow" },
        },
        permissions: [
          { action: "subagent", resource: "*", effect: "allow" },
          { action: "task", resource: "*", effect: "allow" },
          { action: "edit", resource: "*", effect: "allow" },
          { action: "read", resource: "*", effect: "allow" },
        ],
        plugins: [{ package: PRODUCT, options: { schemaVersion: 1 } }],
      }),
    )
    let parentID: string | undefined
    try {
      const run1 = await runOnce(project, {
        title: "omo teams wake probe",
        prompt: "Reply with exactly WAKE-P0 and do not use any tool.",
      })
      dumpEvidence("teams-wake-run1", run1.stdout, run1.stderr)
      expect(run1.exit, `${run1.stderr}\n${run1.stdout}`).toBe(0)
      const events1 = parseEvents(run1.stdout)
      parentID = events1[0]?.sessionID as string | undefined
      expect(parentID, run1.stdout).toBeString()

      const run2 = await runOnce(project, {
        session: parentID,
        prompt:
          `Your session id is ${parentID}. Call the omo_team tool (directly if listed, ` +
          "otherwise through the execute tool by searching for omo.team) EXACTLY three times, in this order:\n" +
          `1. {"action":"create","teamID":"wake-team","members":["${parentID}"],"tasks":[]}\n` +
          `2. {"action":"send","teamID":"wake-team","recipientID":"${parentID}","dedupKey":"w-mail-1","body":"WAKE-MAIL-P-4r9t"}\n` +
          '3. {"action":"status","teamID":"wake-team"}\n' +
          "Never call the read or ack actions — the mail must stay unread. " +
          "After all three calls return, reply with exactly WAKE-P1 done",
      })
      dumpEvidence("teams-wake-run2", run2.stdout, run2.stderr)
      expect(run2.exit, `${run2.stderr}\n${run2.stdout}`).toBe(0)
      const events2 = parseEvents(run2.stdout)
      const teamInvocations = teamInvocationCount(events2)
      expect(teamInvocations, run2.stdout).toBeGreaterThanOrEqual(3)
      expect(textsOf(events2)).toContain("WAKE-P1")

      // The mail is unread, so the session's own idle event must prompt it
      // with the <team_mailbox> block that carries the body.
      let wake: Record<string, unknown> | undefined
      let lastCount = -1
      for (let attempt = 0; attempt < 24 && wake === undefined; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        const messages = await fetchMessages(parentID as string)
        lastCount = messages.length
        wake = messages.find(
          (message) =>
            message.type === "user" &&
            /<team_mailbox/.test(messageText(message)) &&
            messageText(message).includes("WAKE-MAIL-P-4r9t"),
        )
      }
      expect(
        wake,
        `no <team_mailbox wake prompt in session ${parentID} within 120s (${lastCount} messages)`,
      ).toBeTruthy()
    } finally {
      await cleanupSession(parentID)
      await cleanupDir(base)
    }
  },
  480_000,
)
