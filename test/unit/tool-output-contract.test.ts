import { expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { type BoulderOptions, type BoulderStore, openBoulderStore } from "../../src/boulder/store"
import { mountBoulder } from "../../src/boulder/tools"
import { type MonitorView, mountMonitor } from "../../src/terminal/monitor-tools"
import { rmRetry } from "./test-utils"

// The host's `execute` wrapper requires every tool result to carry the declared
// `output` field. Boulder and monitor tools used to return `{ content }` only,
// so the live host answered `Tool did not return its declared output`. This
// suite pins the contract: every mounted tool must return a string `output`
// that equals its `content` (kept for compatibility).

const SESSION_ID = "owner-session"
const PROJECT_ID = "project-1"

interface CapturedTool {
  readonly name: string
  readonly execute: (
    input: unknown,
    context: { sessionID?: string },
  ) => Promise<Record<string, unknown>>
}

interface CaptureEditor {
  namespace: (definition: unknown) => CaptureEditor
  get: (name: string) => undefined
  add: (definition: unknown) => void
}

interface Harness {
  ctx: Plugin.Context
  tools: CapturedTool[]
}

/** A fake host context: captures tool definitions and answers the identity check. */
function harness(directory: string): Harness {
  const tools: CapturedTool[] = []
  const editor: CaptureEditor = {
    namespace: () => editor,
    get: () => undefined,
    add: (definition) => {
      tools.push(definition as CapturedTool)
    },
  }
  const ctx = {
    location: {
      directory,
      project: { id: PROJECT_ID, directory, canonical: directory },
    },
    session: {
      // `owner(context)` rejects a foreign session: the returned session must
      // match the fake location exactly (id, projectID, directory).
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        projectID: PROJECT_ID,
        location: { directory },
      }),
    },
    event: {
      // The liveness loop iterates this; an empty generator ends it at once.
      subscribe: () => (async function* empty() {})(),
    },
    tool: {
      transform: async (callback: (value: CaptureEditor) => void) => {
        callback(editor)
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx: ctx as unknown as Plugin.Context, tools }
}

function tool(tools: readonly CapturedTool[], name: string): CapturedTool {
  const found = tools.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

/** The defect: `output` must be a string and must equal the compatibility `content`. */
async function expectOutputContract(definition: CapturedTool, input: unknown): Promise<void> {
  const result = await definition.execute(input, { sessionID: SESSION_ID })
  expect(typeof result.output, `${definition.name} output type`).toBe("string")
  expect(result.output, `${definition.name} output equals content`).toBe(result.content)
}

interface BoulderHarness extends Harness {
  root: string
  store: BoulderStore
  dispose: () => Promise<void>
}

async function mountBoulderHarness(options?: BoulderOptions): Promise<BoulderHarness> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "omo-tool-output-")))
  await writeFile(join(root, "plan.md"), "# Plan\n- [ ] step one\n- [ ] step two\n")
  const store = openBoulderStore(root, options)
  const { ctx, tools } = harness(root)
  const dispose = await mountBoulder(ctx, root, true, store)
  return { ctx, tools, root, store, dispose }
}

async function cleanup(h: BoulderHarness): Promise<void> {
  await h.dispose()
  h.store.close()
  await rmRetry(h.root)
}

test("boulder_state returns its declared output alongside content", async () => {
  const h = await mountBoulderHarness()
  try {
    await expectOutputContract(tool(h.tools, "boulder_state"), {})
  } finally {
    await cleanup(h)
  }
})

test("boulder_update start and status transitions return the output contract", async () => {
  const h = await mountBoulderHarness()
  const update = tool(h.tools, "boulder_update")
  try {
    await expectOutputContract(update, { action: "start", plan: "plan.md" })
    await expectOutputContract(update, { action: "pause" })
    await expectOutputContract(update, { action: "resume" })
    await expectOutputContract(update, { action: "start", plan: "plan.md" })
    await expectOutputContract(update, { action: "complete" })
    await expectOutputContract(update, { action: "abandon" })
  } finally {
    await cleanup(h)
  }
})

test("boulder_update offer returns the output contract", async () => {
  const h = await mountBoulderHarness()
  const update = tool(h.tools, "boulder_update")
  try {
    const work = h.store.start(SESSION_ID, "plan.md")
    await expectOutputContract(update, {
      action: "offer",
      workID: work.id,
      toSessionID: "child-session",
    })
  } finally {
    await cleanup(h)
  }
})

test("boulder_update claim returns the output contract", async () => {
  const h = await mountBoulderHarness()
  const update = tool(h.tools, "boulder_update")
  try {
    const work = h.store.start("child-session", "plan.md")
    h.store.offer("child-session", work.id, SESSION_ID)
    await expectOutputContract(update, { action: "claim", workID: work.id })
  } finally {
    await cleanup(h)
  }
})

test("boulder_update sweep and recover return the output contract", async () => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z")
  const h = await mountBoulderHarness({ now: () => clock, staleAfterMs: 1000 })
  const update = tool(h.tools, "boulder_update")
  try {
    const work = h.store.start(SESSION_ID, "plan.md")
    clock += 5000
    await expectOutputContract(update, { action: "sweep" })
    await expectOutputContract(update, {
      action: "recover",
      workID: work.id,
      disposition: "resume",
    })
  } finally {
    await cleanup(h)
  }
})

test("monitor tools return the output contract", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "omo-tool-output-")))
  try {
    const { ctx, tools } = harness(root)
    const view: MonitorView = {
      availability: () => ({ available: true }),
      mirrored: () => [{ runID: "s1", name: "run-aaa" }],
      capture: async (runID) => `text for ${runID}`,
    }
    const dispose = await mountMonitor(ctx, { view: () => view })
    try {
      await expectOutputContract(tool(tools, "monitor"), {})
      await expectOutputContract(tool(tools, "look_at"), { sessionID: "s1" })
    } finally {
      await dispose()
    }
  } finally {
    await rmRetry(root, { recursive: true, force: true })
  }
})
