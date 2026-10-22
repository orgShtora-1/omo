import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// Opt-in live proof of `omo_lsp_apply` on the caller's managed host service.
//
// The probe creates one real session in a temp project wired with an lsp
// server config (id "ts"), then has the model call the tool three times:
//   1. a reviewed edit with the correct sha256 expectation  -> applied
//   2. the same edit with a wrong (stale) hash               -> stale-content
//   3. an edit targeting a file outside the server root      -> outside-root
// `applyWorkspaceEdit` never needs a live LSP connection, so this probe does
// not gate on OMO_LSP_REAL (that gate belongs to the direct-client probe in
// lsp.test.ts). The final disk state must be the applied edit and nothing
// else: refusals must not write.
//
// Requires OMO_LIVE=1. Model: OMO_LIVE_MODEL or the free default.

const live = process.env.OMO_LIVE === "1" ? test : test.skip

const MODEL = process.env.OMO_LIVE_MODEL ?? "opencode/deepseek-v4.1-flash-free"
const PRODUCT = "C:/Users/airshakur88/Documents/GitHub/OmO/hallaxius/omo"

const ORIGINAL = 'const greeting = "hello"\nexport const value = greeting\n'
const EDITED = 'const greeting = "world"\nexport const value = greeting\n'

type Event = Record<string, unknown>

function dumpEvidence(tag: string, stdout: string, stderr?: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs")
    const dir = join(tmpdir(), "opencode", "omo-hashline-evidence")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(dir, `${tag}-${Date.now()}.stdout.jsonl`), stdout)
    if (stderr !== undefined) fs.writeFileSync(join(dir, `${tag}-${Date.now()}.stderr.txt`), stderr)
  } catch {
    // Forensic dump is best-effort; never fail the probe on it.
  }
}

async function cleanupSession(sessionID: string): Promise<void> {
  try {
    const run = Bun.spawn(["opencode", "session", "delete", sessionID], {
      stdout: "ignore",
      stderr: "ignore",
    })
    await run.exited
  } catch {
    // Best-effort: the managed host keeps sessions for manual cleanup.
  }
}

async function cleanupDir(base: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(base, { recursive: true, force: true })
      return
    } catch {
      // Windows EBUSY: the managed host keeps SQLite handles on the plugin
      // state directory. Retry; leave the rest to manual cleanup.
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
}

async function setupProject(): Promise<{
  base: string
  project: string
  appPath: string
  outsidePath: string
}> {
  const base = await mkdtemp(join(tmpdir(), "omo-lsp-live-"))
  const project = join(base, "project")
  await mkdir(project)
  const appPath = join(project, "app.ts")
  const outsidePath = join(base, "outside.ts")
  await writeFile(appPath, ORIGINAL, "utf8")
  await writeFile(outsidePath, "export const outside = 1\n", "utf8")
  await writeFile(
    join(project, "opencode.jsonc"),
    JSON.stringify(
      {
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
              lsp: {
                enabled: true,
                servers: [
                  {
                    id: "ts",
                    command: "typescript-language-server",
                    args: ["--stdio"],
                    languageId: "typescript",
                    extensions: [".ts"],
                    timeoutMs: 15000,
                  },
                ],
              },
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  )
  return { base, project, appPath, outsidePath }
}

async function runOnce(
  project: string,
  options: { title?: string; prompt: string },
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const args = ["opencode", "run", "--agent", "executor", "--format", "json"]
  if (options.title !== undefined) args.push("--title", options.title)
  args.push("--model", MODEL, options.prompt)
  const run = Bun.spawn(args, { cwd: project, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ])
  return { stdout, stderr, exit }
}

function parseEvents(stdout: string): Event[] {
  const events: Event[] = []
  for (const line of stdout.trim().split(/\r?\n/)) {
    if (line === "") continue
    try {
      events.push(JSON.parse(line) as Event)
    } catch {
      // Skip non-JSON noise lines.
    }
  }
  return events
}

function calls(events: Event[], needle: string): Event[] {
  return events.filter((event) => {
    if (event.type !== "tool_use") return false
    const part = (event.part ?? {}) as { tool?: unknown; state?: { input?: unknown } }
    const tool = typeof part.tool === "string" ? part.tool : ""
    const input = JSON.stringify(part.state?.input ?? "")
    return tool === `omo_${needle}` || tool === `omo.${needle}` || input.includes(`omo.${needle}(`)
  })
}

function dumpOf(event: Event): string {
  const part = (event.part ?? {}) as {
    state?: { output?: unknown; content?: unknown; error?: unknown }
  }
  const state = part.state ?? {}
  return JSON.stringify([state.output ?? null, state.content ?? null, state.error ?? null])
}

function textsOf(events: Event[]): string {
  return events
    .filter((event) => event.type === "text")
    .map((event) => String(((event.part ?? {}) as { text?: unknown }).text ?? ""))
    .join("\n")
}

function firstSessionID(events: Event[]): string {
  for (const event of events) {
    const id = event.sessionID
    if (typeof id === "string" && id !== "") return id
  }
  return ""
}

live(
  "lsp apply applies reviewed edits and refuses stale and outside-root",
  async () => {
    const { base, project, appPath, outsidePath } = await setupProject()
    const appUri = pathToFileURL(appPath).href
    const outsideUri = pathToFileURL(outsidePath).href
    const hashBefore = createHash("sha256").update(ORIGINAL, "utf8").digest("hex")
    const staleHash = createHash("sha256").update("stale-probe-hash", "utf8").digest("hex")

    const applyEditJson =
      `{"serverID":"ts","edit":{"documentChanges":[{"textDocument":{"uri":"${appUri}","version":null},` +
      `"edits":[{"range":{"start":{"line":0,"character":17},"end":{"line":0,"character":24}},"newText":"\\"world\\""}]}]},` +
      `"expectedHashes":{"${appUri}":"${hashBefore}"}}`
    const staleEditJson =
      `{"serverID":"ts","edit":{"documentChanges":[{"textDocument":{"uri":"${appUri}","version":null},` +
      `"edits":[{"range":{"start":{"line":0,"character":17},"end":{"line":0,"character":24}},"newText":"\\"world\\""}]}]},` +
      `"expectedHashes":{"${appUri}":"${staleHash}"}}`
    const outsideEditJson =
      `{"serverID":"ts","edit":{"documentChanges":[{"textDocument":{"uri":"${outsideUri}","version":null},` +
      `"edits":[{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":5}},"newText":"// x"}]}]},` +
      `"expectedHashes":{}}`

    const prompt = [
      "You are verifying a code-editing tool in this sandbox project. Follow the numbered steps exactly.",
      "If the omo_lsp_apply tool is not directly listed, use the execute tool and first run search with query 'omo.lsp_apply', then call it via the search-provided reference.",
      "Do not retry a step after it fails; copy the exact output or error you received. Never edit files by any other means.",
      "",
      "Step 1: Call the omo_lsp_apply tool once with exactly this JSON payload:",
      applyEditJson,
      "Copy the exact tool output on a line starting with LSP-STEP1=",
      "",
      "Step 2: Call the omo_lsp_apply tool once with exactly this JSON payload:",
      staleEditJson,
      "This call is expected to be refused. Copy the exact tool output or error on a line starting with LSP-STEP2=",
      "",
      "Step 3: Call the omo_lsp_apply tool once with exactly this JSON payload:",
      outsideEditJson,
      "This call is expected to be refused. Copy the exact tool output or error on a line starting with LSP-STEP3=",
      "",
      "Step 4: Read the file app.ts with your native read tool and copy its exact full content on a line starting with LSP-STEP4=",
      "",
      "Finally reply with a single line: OMO-LSP-P1 status=<applied|refused|partial> detail=<one short sentence>",
    ].join("\n")

    const run = await runOnce(project, { title: "omo lsp-apply live probe", prompt })
    try {
      dumpEvidence("lsp-apply", run.stdout, run.stderr)
      expect(run.exit, `${run.stderr}\n${run.stdout}`).toBe(0)

      const events = parseEvents(run.stdout)
      const sessionID = firstSessionID(events)
      expect(sessionID, run.stdout).toBeString()

      const applyCalls = calls(events, "lsp_apply")
      expect(applyCalls.length, run.stdout).toBeGreaterThanOrEqual(3)

      const dumps = applyCalls.map(dumpOf)
      const appliedReceipt = dumps.find((dump) => /applied/.test(dump) && /files/.test(dump))
      expect(appliedReceipt !== undefined, JSON.stringify(dumps, null, 2)).toBe(true)

      const staleReceipt = dumps.find((dump) => /stale-content/.test(dump))
      expect(staleReceipt !== undefined, JSON.stringify(dumps, null, 2)).toBe(true)

      const outsideReceipt = dumps.find((dump) => /outside-root/.test(dump))
      expect(outsideReceipt !== undefined, JSON.stringify(dumps, null, 2)).toBe(true)

      const disk = await readFile(appPath, "utf8")
      expect(disk, `${run.stderr}\n${run.stdout}`).toBe(EDITED)

      expect(textsOf(events)).toContain("OMO-LSP-P1")
    } finally {
      await cleanupSession(firstSessionID(parseEvents(run.stdout)))
      await cleanupDir(base)
    }
  },
  300_000,
)
