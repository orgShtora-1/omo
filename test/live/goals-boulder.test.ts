import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Opt-in live probe of the goal lifecycle and the boulder work registry on the
// caller's managed host (no `--standalone`): standalone servers own an empty
// database and see zero routable models. Five independent tests:
//
//   -t lifecycle    goal create/pause/resume/cancel + terminal refusals
//   -t handoff      boulder start -> offer -> child claim -> parent loses work
//   -t breach       maxTokens:1 budget breach auto-pause (depends on
//                   session.usage.updated reaching the plugin on this host)
//   -t continuation goal continuation prompt after idle (depends on
//                   session.idle; known NOT to fire on the managed host — this
//                   test documents that gap honestly and is expected to fail)
//   -t compaction   boulder updatedAt renewal across native /compact
//
// Env: OMO_LIVE=1 plus OMO_LIVE_MODEL with an explicitly authorized model.
// Sessions created in the caller's host are deleted best-effort; probe
// projects are temp dirs removed best-effort (Windows EBUSY when the host
// keeps plugin sqlite handles is tolerated, never masks probe assertions).
// Evidence dumps: %TEMP%/opencode/omo-hashline-evidence/gb-*.

const live = process.env.OMO_LIVE === "1" ? test : test.skip
const MODEL = process.env.OMO_LIVE_MODEL ?? "opencode/deepseek-v4.1-flash-free"
const PRODUCT = "C:/Users/airshakur88/Documents/GitHub/OmO/hallaxius/omo"

type Event = Record<string, unknown>
type CallState = {
  status?: string
  output?: unknown
  content?: unknown
  error?: string
  input?: unknown
}
type RunResult = { stdout: string; stderr: string; exit: number }
type Message = Record<string, unknown>

const partOf = (event: Event) =>
  (event.part ?? {}) as { tool?: string; text?: string; state?: CallState }

const dumpEvidence = (tag: string, stdout: string, stderr?: string): void => {
  try {
    const fs = require("node:fs")
    fs.mkdirSync(join(tmpdir(), "opencode", "omo-hashline-evidence"), { recursive: true })
    fs.writeFileSync(
      join(tmpdir(), "opencode", "omo-hashline-evidence", `gb-${tag}-${Date.now()}.stdout.jsonl`),
      stdout,
    )
    if (stderr !== undefined) {
      fs.writeFileSync(
        join(tmpdir(), "opencode", "omo-hashline-evidence", `gb-${tag}-${Date.now()}.stderr.txt`),
        stderr,
      )
    }
  } catch {
    // Forensic only; never fails the probe.
  }
}

const cleanupSession = async (sessionID: string): Promise<void> => {
  try {
    await Bun.spawn(["opencode", "session", "delete", sessionID]).exited
  } catch {
    // Best effort; the host may keep references.
  }
}

const cleanupDir = async (base: string): Promise<void> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(base, { recursive: true, force: true })
      return
    } catch {
      // Windows: the managed host keeps plugin sqlite handles open (EBUSY).
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
}

const setupProject = async () => {
  const base = await mkdtemp(join(tmpdir(), "omo-gb-live-"))
  const project = join(base, "project")
  await mkdir(project)
  await writeFile(join(project, "plan.md"), "# Probe plan\nstep one\nstep two\n")
  await writeFile(
    join(project, "opencode.jsonc"),
    JSON.stringify(
      {
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
        plugins: [{ package: PRODUCT, options: { schemaVersion: 1, goal_enabled: true } }],
      },
      null,
      2,
    ),
  )
  return { base, project }
}

const runOnce = async (
  project: string,
  options: { title?: string; session?: string; prompt: string },
): Promise<RunResult> => {
  const args = ["opencode", "run", "--agent", "executor", "--format", "json"]
  if (options.title !== undefined) args.push("--title", options.title)
  if (options.session !== undefined) args.push("--session", options.session)
  args.push("--model", MODEL, options.prompt)
  const run = Bun.spawn(args, { cwd: project, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ])
  return { stdout, stderr, exit }
}

const parseEvents = (stdout: string): Event[] =>
  stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Event)

const calls = (events: Event[], needle: string): Event[] =>
  events.filter((event) => {
    if (event.type !== "tool_use") return false
    const part = partOf(event)
    if (part.tool === undefined) return false
    if (part.tool === `omo_${needle}` || part.tool === `omo.${needle}`) return true
    return JSON.stringify(part.state?.input ?? "").includes(`omo.${needle}(`)
  })

const stateOf = (event: Event): CallState => partOf(event).state ?? {}

// Boulder tools return {output, content}; goal/team tools return {output};
// refusals may also surface as state.error. Keep all three in every receipt
// dump.
const dumpOf = (event: Event): string =>
  JSON.stringify([
    stateOf(event).output ?? null,
    stateOf(event).content ?? null,
    stateOf(event).error ?? null,
  ])

const textsOf = (events: Event[]): string =>
  events
    .filter((event) => event.type === "text")
    .map((event) => String(partOf(event).text ?? ""))
    .join("\n")

const extractSessionID = (blob: string): string | undefined => {
  const patterns = [
    /"sessionID"\s*:\s*"([^"]+)"/,
    /\\?"sessionID\\?"\s*:\s*\\?"([^"\\]+)/,
    /sessionID"?\s*:\s*\\?"([^"\\]+)/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(blob)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

const extractWorkID = (blob: string): string | undefined => {
  const patterns = [
    /"work"\s*:\s*\{[\s\S]*?"id"\s*:\s*"([^"]+)"/,
    /\\?"work\\?"\s*:\s*\\?\{[\s\S]*?\\?"id\\?"\s*:\s*\\?"([^"\\]+)/,
    /"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/,
    /\\?"id\\?"\s*:\s*\\?"([0-9a-f-]{8,})/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(blob)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

const actionOf = (event: Event): string | undefined => {
  const blob = JSON.stringify(stateOf(event).input ?? "")
  const direct = /"action"\s*:\s*"([^"]+)"/.exec(blob)
  if (direct?.[1] !== undefined) return direct[1]
  const escaped = /\\?"action\\?"\s*:\s*\\?"([^"\\]+)/.exec(blob)
  if (escaped?.[1] !== undefined) return escaped[1]
  const literal = /action"?\s*:\s*\\?"([a-z_]+)/.exec(blob)
  if (literal?.[1] !== undefined) return literal[1]
  return undefined
}

const fetchMessages = async (sessionID: string): Promise<Message[]> => {
  const api = Bun.spawn(["opencode", "api", "get", `/api/session/${sessionID}/message`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(api.stdout).text(),
    new Response(api.stderr).text(),
    api.exited,
  ])
  if (code !== 0) throw new Error(`opencode api get failed (${code}): ${err}`)
  return (JSON.parse(out) as { data?: Message[] }).data ?? []
}

const messageText = (message: Message): string => {
  if (typeof message.text === "string") return message.text
  const parts = (message.content ?? []) as Array<{ type?: string; text?: string }>
  return parts.map((part) => part.text ?? "").join("")
}

const firstSessionID = (events: Event[]): string | undefined => {
  for (const event of events) {
    const candidate = event.sessionID
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
}

live(
  "goal lifecycle and terminal refusals end to end",
  async () => {
    const { base, project } = await setupProject()
    try {
      const prompt = [
        "You are verifying the omo goal tool lifecycle on this machine. Execute exactly these steps in order, each through a tool call.",
        "If a tool is not directly listed, use the execute tool and first run search with query 'omo.goal', then call it via the search-provided reference.",
        "Use each payload EXACTLY as given. Do not retry a step after it returns an error or a refusal; copy the exact text it returned.",
        "",
        'Step 1: call omo_create_goal with {"objective": "goal-A", "limits": {"maxTokens": 1000000}} and copy its full output.',
        "Step 2: call omo_get_goal with {} and copy its full output.",
        'Step 3: call omo_update_goal with {"status": "paused"} and copy its full output.',
        'Step 4: call omo_update_goal with {"status": "active"} and copy its full output.',
        'Step 5: call omo_update_goal with {"status": "cancelled"} and copy its full output.',
        'Step 6: call omo_update_goal with {"status": "active"} and copy the exact output or error text.',
        'Step 7: call omo_create_goal with {"objective": "goal-B"} and copy the exact output or error text.',
        "",
        "Then reply with EXACTLY one line per step in the form GB-STEP<n>=<the full output or error text you received> and finish with a final line OMO-GB-LIFE status=<done>. Do not add any other text.",
      ].join("\n")
      const run = await runOnce(project, { title: "omo goals-boulder lifecycle probe", prompt })
      dumpEvidence("life-run1", run.stdout, run.stderr)
      const events = parseEvents(run.stdout)
      const sessionID = firstSessionID(events)
      expect(run.exit, `${run.stderr}\n${run.stdout}`).toBe(0)
      expect(sessionID, run.stdout).toBeString()

      const creates = calls(events, "create_goal")
      const gets = calls(events, "get_goal")
      const updates = calls(events, "update_goal")
      expect(creates.length + gets.length + updates.length, run.stdout).toBeGreaterThanOrEqual(5)

      const createDumps = creates.map(dumpOf).join("\n")
      const updateDumps = updates.map(dumpOf).join("\n")
      const texts = textsOf(events)

      // Steps 1, 3, 4, 5 succeeded with their target statuses.
      expect(createDumps, run.stdout).toMatch(/status[\\":\s]*active/)
      expect(updateDumps, run.stdout).toMatch(/status[\\":\s]*paused/)
      expect(updateDumps, run.stdout).toMatch(/status[\\":\s]*active/)
      expect(updateDumps, run.stdout).toMatch(/status[\\":\s]*cancelled/)
      // Step 6: update_goal after cancellation is refused — goal tools return
      // errors as output, so the refusal text lives in the receipt dump.
      expect(updateDumps, run.stdout).toContain("cancelled goal is terminal")
      // Step 7: create_goal after cancellation is refused too (set is terminal-refusal).
      expect(createDumps, run.stdout).toContain("cancelled goal is terminal")
      expect(texts, run.stdout).toContain("OMO-GB-LIFE")
    } finally {
      await cleanupDir(base)
    }
  },
  480_000,
)

live(
  "boulder handoff moves work across sessions",
  async () => {
    const { base, project } = await setupProject()
    let parentID: string | undefined
    let childID: string | undefined
    try {
      const run1 = await runOnce(project, {
        title: "omo goals-boulder handoff probe",
        prompt: [
          "You are preparing a boulder handoff test on this machine. Execute exactly these steps in order.",
          "If a tool is not directly listed, use the execute tool and first run search with query 'omo.boulder' or 'omo.delegate', then call it via the search-provided reference.",
          "Use each payload EXACTLY as given. Do not retry a step after it fails; copy the exact output or error.",
          "",
          'Step 1: call omo_delegate ONCE with {"taskID": "gb-live-0", "prompt": "Reply with exactly CHILD-READY and nothing else.", "route": {"kind": "agent", "id": "executor"}, "background": false} and copy its full output.',
          'Step 2: call omo_boulder_update with {"action": "start", "plan": "plan.md"} and copy its full output.',
          "Step 3: call omo_boulder_state with {} and copy its full output.",
          "",
          "Then reply with EXACTLY one line per step in the form GB-STEP<n>=<the full output or error text> and finish with a final line OMO-GB-P1 status=<done>. Do not add any other text.",
        ].join("\n"),
      })
      dumpEvidence("hand-run1", run1.stdout, run1.stderr)
      const events1 = parseEvents(run1.stdout)
      parentID = firstSessionID(events1)
      expect(run1.exit, `${run1.stderr}\n${run1.stdout}`).toBe(0)
      expect(parentID, run1.stdout).toBeString()

      const delegates1 = calls(events1, "delegate")
      expect(delegates1.length, run1.stdout).toBeGreaterThanOrEqual(1)
      childID = extractSessionID(delegates1.map(dumpOf).join("\n"))
      expect(childID, run1.stdout).toBeString()
      // The delegate receipt is only {"attemptID","sessionID","state"} — it
      // carries no child text. Prove the child really replied by reading the
      // child session's own messages through the API instead.
      if (childID === undefined) throw new Error("delegate receipt did not name the child session")
      const childMessages1 = await fetchMessages(childID)
      const childProof1 = childMessages1.map(messageText).join("\n")
      expect(childProof1, `child session ${childID}`).toContain("CHILD-READY")

      const starts = calls(events1, "boulder_update").filter((call) => actionOf(call) === "start")
      const workID = extractWorkID(starts.map(dumpOf).join("\n"))
      expect(workID, run1.stdout).toBeString()

      const states1 = calls(events1, "boulder_state").map(dumpOf).join("\n")
      expect(states1, run1.stdout).toContain(workID ?? "")
      expect(textsOf(events1), run1.stdout).toContain("OMO-GB-P1")

      // Run 2: the parent offers the work and delegates the claim to the child.
      // A delegate to a REUSED child session can return before that session's
      // fresh turn lands (session.wait may observe the idle session from the
      // previous run), and the delegate receipt never carries child text. So the
      // post-claim reads wait for run 3, after the test has seen the child's own
      // CLAIM-OK through the API.
      const run2 = await runOnce(project, {
        session: parentID,
        prompt: [
          "You are completing a boulder handoff test in this session. Execute exactly these steps in order.",
          "If a tool is not directly listed, use the execute tool and first run search with query 'omo.boulder' or 'omo.delegate', then call it via the search-provided reference.",
          "Use each payload EXACTLY as given. Do not retry a step after it fails; copy the exact output or error.",
          "",
          `Step 1: call omo_boulder_update with {"action": "offer", "workID": "${workID}", "toSessionID": "${childID}"} and copy its full output.`,
          `Step 2: call omo_delegate ONCE with {"taskID": "gb-live-1", "sessionID": "${childID}", "prompt": "Call the omo_boulder_update tool once with {\\"action\\": \\"claim\\", \\"workID\\": \\"${workID}\\"}. If it is not listed, use the execute tool and first run search with query 'omo.boulder', then call it via the search-provided reference. Then reply with exactly CLAIM-OK followed by the status value from that tool output.", "route": {"kind": "agent", "id": "executor"}, "background": false} and copy its full output.`,
          "",
          "Then reply with EXACTLY one line per step in the form GB-STEP<n>=<the full output or error text> and finish with a final line OMO-GB-P2 status=<done>. Do not add any other text.",
        ].join("\n"),
      })
      dumpEvidence("hand-run2", run2.stdout, run2.stderr)
      const events2 = parseEvents(run2.stdout)
      expect(run2.exit, `${run2.stderr}\n${run2.stdout}`).toBe(0)

      const boulderUpdates2 = calls(events2, "boulder_update")
      const offers = boulderUpdates2
        .filter((call) => actionOf(call) === "offer")
        .map(dumpOf)
        .join("\n")
      expect(offers, run2.stdout).toMatch(/offer/i)
      expect(textsOf(events2), run2.stdout).toContain("OMO-GB-P2")

      // The child session itself (via API) proves the claim really ran there.
      // The delegate receipt has no child text, so poll the child's own messages
      // until it replies CLAIM-OK (the child was told to reply exactly that).
      let childProof = ""
      for (let attempt = 0; attempt < 24; attempt += 1) {
        const childMessages = await fetchMessages(childID)
        childProof = childMessages.map(messageText).join("\n")
        if (childProof.includes("CLAIM-OK")) break
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
      expect(childProof, `child session ${childID}`).toContain("CLAIM-OK")

      // Run 3: the parent reads its own registry and tries to pause the work it
      // handed off. The claim has landed (proven above), so the work is gone.
      const run3 = await runOnce(project, {
        session: parentID,
        prompt: [
          "You are verifying a completed boulder handoff in this session. Execute exactly these steps in order.",
          "If a tool is not directly listed, use the execute tool and first run search with query 'omo.boulder', then call it via the search-provided reference.",
          "Use each payload EXACTLY as given. Do not retry a step after it fails; copy the exact output or error.",
          "",
          "Step 1: call omo_boulder_state with {} and copy its full output.",
          `Step 2: call omo_boulder_update with {"action": "pause", "workID": "${workID}"} and copy the exact output or error text.`,
          "",
          "Then reply with EXACTLY one line per step in the form GB-STEP<n>=<the full output or error text> and finish with a final line OMO-GB-P3 status=<done>. Do not add any other text.",
        ].join("\n"),
      })
      dumpEvidence("hand-run3", run3.stdout, run3.stderr)
      const events3 = parseEvents(run3.stdout)
      expect(run3.exit, `${run3.stderr}\n${run3.stdout}`).toBe(0)
      expect(textsOf(events3), run3.stdout).toContain("OMO-GB-P3")

      // After the claim the work left the parent's registry: the LAST
      // boulder_state receipt must not mention the workID anymore.
      const states3 = calls(events3, "boulder_state")
      expect(states3.length, run3.stdout).toBeGreaterThanOrEqual(1)
      const lastStateCall = states3.length > 0 ? states3[states3.length - 1] : undefined
      const lastStateDump = lastStateCall === undefined ? "" : dumpOf(lastStateCall)
      expect(lastStateDump, run3.stdout).not.toContain(workID ?? "")

      // Pausing a work the parent no longer owns is refused: the transition
      // finds no such work and the tool reports a null work, never a paused one.
      const pauseDumps = calls(events3, "boulder_update")
        .filter((call) => actionOf(call) === "pause")
        .map(dumpOf)
        .join("\n")
      expect(pauseDumps, run3.stdout).toMatch(/null|error|unknown|refus/i)
      expect(pauseDumps, run3.stdout).not.toContain("paused")
    } finally {
      if (parentID !== undefined) await cleanupSession(parentID)
      if (childID !== undefined) await cleanupSession(childID)
      await cleanupDir(base)
    }
  },
  900_000,
)

live(
  "budget breach auto-pauses the goal",
  async () => {
    const { base, project } = await setupProject()
    let parentID: string | undefined
    try {
      // Run 1 creates the goal and burns far more than maxTokens:1. The host
      // emits session.usage.updated only at run end, so a breach can never be
      // observed in the same run that spends the tokens: it is read back in a
      // second run against the same session, which proves cross-run accrual.
      const run1 = await runOnce(project, {
        title: "omo goals-boulder breach probe",
        prompt: [
          "You are verifying goal budget enforcement on this machine. Execute exactly these steps in order.",
          "If a tool is not directly listed, use the execute tool and first run search with query 'omo.goal', then call it via the search-provided reference.",
          "Use each payload EXACTLY as given.",
          "",
          'Step 1: call omo_create_goal with {"objective": "BREACH-PROBE report the sea", "limits": {"maxTokens": 1}} and copy its full output.',
          "Step 2: write a paragraph about the sea (about 120 words). This burns tokens on purpose. Do not call any tool in this step. End the paragraph with the marker BREACH-BURN.",
          "",
          "Then reply with EXACTLY one line per step in the form GB-STEP<n>=<the paragraph for step 2, otherwise the full output> and finish with a final line OMO-GB-BREACH status=<done>. Do not add any other text.",
        ].join("\n"),
      })
      dumpEvidence("breach-run1", run1.stdout, run1.stderr)
      const events1 = parseEvents(run1.stdout)
      parentID = firstSessionID(events1)
      expect(run1.exit, `${run1.stderr}\n${run1.stdout}`).toBe(0)
      expect(parentID, run1.stdout).toBeString()

      const creates = calls(events1, "create_goal").map(dumpOf).join("\n")
      expect(creates, run1.stdout).toMatch(/status[\\":\s]*active/)

      const texts1 = textsOf(events1)
      expect(texts1, run1.stdout).toContain("BREACH-BURN")
      expect(texts1, run1.stdout).toContain("OMO-GB-BREACH")

      // Run 2 resumes the same session and reads the goal back. Run 1's
      // run-end usage event has now accrued against the session, so the breach
      // fires: the goal must be paused and carry limitExceeded. If the
      // session.usage.updated event family does not flow on the managed host
      // (same open question as the idle-wake gap), this assertion fails
      // honestly and documents the gap.
      if (parentID === undefined) throw new Error("breach run did not report a session id")
      const run2 = await runOnce(project, {
        session: parentID,
        prompt: [
          "You are reading back a goal budget breach in this session. Execute exactly this step.",
          "If the tool is not directly listed, use the execute tool and first run search with query 'omo.goal', then call it via the search-provided reference.",
          "Use the payload EXACTLY as given.",
          "",
          "Step 1: call omo_get_goal with {} and copy its full output.",
          "",
          "Then reply with EXACTLY GB-STEP1=<the full output> and finish with a final line OMO-GB-BREACH2 status=<done>. Do not add any other text.",
        ].join("\n"),
      })
      dumpEvidence("breach-run2", run2.stdout, run2.stderr)
      const events2 = parseEvents(run2.stdout)
      expect(run2.exit, `${run2.stderr}\n${run2.stdout}`).toBe(0)

      const gets = calls(events2, "get_goal")
      const lastGetCall = gets.length > 0 ? gets[gets.length - 1] : undefined
      const lastGet = lastGetCall === undefined ? "" : dumpOf(lastGetCall)
      expect(
        lastGet,
        `${run2.stdout}\nExpected paused + limitExceeded after burning >1 token`,
      ).toMatch(/status[\\":\s]*paused/)
      expect(lastGet, run2.stdout).toMatch(/limitExceeded/)
    } finally {
      if (parentID !== undefined) await cleanupSession(parentID)
      await cleanupDir(base)
    }
  },
  540_000,
)

live(
  "goal continuation prompts the idle session",
  async () => {
    // Goal continuation is driven by the same host event family as the team
    // idle-wake (session.idle). The teams-runtime probe established that this
    // event is NOT delivered to plugins on the managed host (opencode 2.0.24
    // service): three stable 120s polls observed zero wake prompts while an
    // unacknowledged mailbox message was pending. The continuation handler
    // shares that dependency and a silent catch-all, so this probe expects
    // the same honest failure and exists to document the gap with evidence.
    const { base, project } = await setupProject()
    let sessionID: string | undefined
    try {
      const run = await runOnce(project, {
        title: "omo goals-boulder continuation probe",
        prompt: [
          "You are verifying goal continuation on this machine. Execute exactly these steps.",
          "If a tool is not directly listed, use the execute tool and first run search with query 'omo.goal', then call it via the search-provided reference.",
          "Use each payload EXACTLY as given.",
          "",
          'Step 1: call omo_create_goal with {"objective": "CONT-PROBE always reply CONT-OK"} and copy its full output.',
          "",
          "Then reply with EXACTLY GB-STEP1=<the full output> and finish with a final line OMO-GB-CONT status=<done>. Do not add any other text.",
        ].join("\n"),
      })
      dumpEvidence("cont-run1", run.stdout, run.stderr)
      const events = parseEvents(run.stdout)
      sessionID = firstSessionID(events)
      expect(run.exit, `${run.stderr}\n${run.stdout}`).toBe(0)
      expect(sessionID, run.stdout).toBeString()

      const creates = calls(events, "create_goal").map(dumpOf).join("\n")
      expect(creates, run.stdout).toMatch(/status[\\":\s]*active/)
      expect(textsOf(events), run.stdout).toContain("OMO-GB-CONT")

      // Poll the session for the continuation prompt the plugin injects via
      // ctx.session.prompt when the host reports the session idle.
      let count = 0
      let found = false
      for (let attempt = 0; attempt < 24 && !found; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        const messages = sessionID === undefined ? [] : await fetchMessages(sessionID)
        count = messages.length
        found = messages.some(
          (message) => message.type === "user" && messageText(message).includes("[omo goal]"),
        )
      }
      expect(
        found,
        `no [omo goal] continuation prompt in session ${sessionID ?? "?"} within 120s (${count} messages)`,
      ).toBe(true)
    } finally {
      if (sessionID !== undefined) await cleanupSession(sessionID)
      await cleanupDir(base)
    }
  },
  480_000,
)

live(
  "boulder work stays live across native compaction",
  async () => {
    const { base, project } = await setupProject()
    try {
      const prompt = [
        "You are verifying that boulder works survive native compaction on this machine. Execute exactly these steps in order.",
        "If a tool is not directly listed, use the execute tool and first run search with query 'omo.boulder' or 'omo.compact', then call it via the search-provided reference.",
        "Use each payload EXACTLY as given. Do not retry a step after it fails; copy the exact output or error.",
        "",
        'Step 1: call omo_boulder_update with {"action": "start", "plan": "plan.md"} and copy its full output.',
        "Step 2: call omo_boulder_state with {} and copy its full output.",
        "Step 3: call omo_compact with {} and copy its full output.",
        "Step 4: call omo_boulder_state with {} and copy its full output.",
        "",
        "Then reply with EXACTLY one line per step in the form GB-STEP<n>=<the full output or error text> and finish with a final line OMO-GB-COMPACT status=<done>. Do not add any other text.",
      ].join("\n")
      const run = await runOnce(project, { title: "omo goals-boulder compaction probe", prompt })
      dumpEvidence("compact-run1", run.stdout, run.stderr)
      const events = parseEvents(run.stdout)
      const sessionID = firstSessionID(events)
      expect(run.exit, `${run.stderr}\n${run.stdout}`).toBe(0)
      expect(sessionID, run.stdout).toBeString()

      const boulderDumps = [...calls(events, "boulder_update"), ...calls(events, "boulder_state")]
        .map(dumpOf)
        .join("\n")
      expect(boulderDumps, run.stdout).toContain("plan.md")

      const states = calls(events, "boulder_state")
      expect(states.length, run.stdout).toBeGreaterThanOrEqual(2)

      // compaction.ended renews updatedAt of the caller's own active work.
      // The product contract stores ISO-8601 timestamp strings
      // (src/boulder/store.ts), so parse those; the epoch-ms branch stays as
      // a legacy fallback. Compare the first and the last state receipts in
      // call order; equality means the event never reached the plugin.
      // The dump may carry backslash-escaped quotes, so both branches
      // tolerate an optional backslash around quotes.
      const updatedAtValues = states
        .map(dumpOf)
        .flatMap((dump) => {
          const values: number[] = []
          for (const match of dump.match(/\\?"updatedAt\\?"\s*:\\?\s*\\?"([^"\\]+)\\?"/g) ?? []) {
            const text = /\\?"updatedAt\\?"\s*:\\?\s*\\?"([^"\\]+)\\?"/.exec(match)?.[1]
            if (text !== undefined) {
              const time = Date.parse(text)
              if (Number.isFinite(time)) values.push(time)
            }
          }
          for (const match of dump.match(/updatedAt[\\":\s]*(\d{12,})/g) ?? []) {
            const value = /(\d{12,})/.exec(match)?.[1]
            if (value !== undefined) values.push(Number(value))
          }
          return values
        })
        .filter((value) => Number.isFinite(value))
      expect(updatedAtValues.length, run.stdout).toBeGreaterThanOrEqual(2)
      const first = updatedAtValues[0] ?? Number.NaN
      const last = updatedAtValues[updatedAtValues.length - 1] ?? Number.NaN
      expect(
        last,
        `compaction did not renew boulder updatedAt (first=${first}, last=${last}) — compaction.ended may not reach plugins on this host`,
      ).toBeGreaterThan(first)

      const lastStateCall = states.length > 0 ? states[states.length - 1] : undefined
      const lastState = lastStateCall === undefined ? "" : dumpOf(lastStateCall)
      expect(lastState, run.stdout).toContain("plan.md")
      expect(lastState, run.stdout).toMatch(/status[\\":\s]*active/)
      expect(textsOf(events), run.stdout).toContain("OMO-GB-COMPACT")
    } finally {
      await cleanupDir(base)
    }
  },
  480_000,
)
