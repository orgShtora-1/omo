import { expect, setSystemTime, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { parseOptions } from "../../src/config/schema"
import { openReflectionQueue } from "../../src/memory/reflection-queue"
import { memoryScope } from "../../src/memory/store"
import { mountMemory } from "../../src/memory/tools"

type ToolRecord = {
  name: string
  description: string
  options: { namespace?: string; permission?: string }
  input: Record<string, unknown>
  output: unknown
  execute(input: Record<string, unknown>, context: unknown): Promise<unknown> | unknown
}

type CompactionHook = (input: {
  sessionID: string
  agent?: string
  result?: { summary?: string }
  messages?: unknown[]
}) => Promise<void>

function fixture(canonical: string, foreign: "project" | "location" | "identity" | false = false) {
  const added: ToolRecord[] = []
  const hooks: Record<string, { handler: CompactionHook; disposed: boolean }> = {}
  const ctx = {
    location: {
      directory: join(canonical, "session"),
      project: { id: "proj_test", canonical },
    },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        return {
          id: foreign === "identity" ? "different-session" : sessionID,
          projectID:
            foreign === "project" || sessionID === "outside" ? "other-project" : "proj_test",
          location: { directory: join(canonical, foreign === "location" ? "other" : "session") },
        }
      },
      async hook(name: string, handler: CompactionHook) {
        const record = { handler, disposed: false }
        hooks[name] = record
        return {
          async dispose() {
            record.disposed = true
          },
        }
      },
    },
    tool: {
      async transform(editor: (editor: unknown) => unknown | Promise<unknown>) {
        const target = {
          namespace() {},
          get() {
            return undefined
          },
          add(record: ToolRecord) {
            added.push(record)
          },
        }
        await editor(target)
        return { dispose() {} }
      },
    },
  }
  return { ctx: ctx as unknown as Plugin.Context, added, hooks }
}

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "omo-memory-it-"))
  const stateDir = await mkdtemp(join(tmpdir(), "omo-memory-state-"))
  return {
    dir,
    stateDir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}

test("memory_enabled defaults to false in the config schema", () => {
  expect((parseOptions({ schemaVersion: 1 }) as { memory_enabled?: boolean }).memory_enabled).toBe(
    false,
  )
  expect(() => parseOptions({ schemaVersion: 1, memory_enabled: 1 })).toThrow()
})

test("context ingestion stores step text only for the native session", async () => {
  const { dir, stateDir, cleanup } = await tempDir()
  const { ctx, added, hooks } = fixture(dir)
  const dispose = await mountMemory(ctx, stateDir, true)
  let disposed = false
  try {
    const context = hooks.context?.handler
    if (!context) throw new Error("missing context ingestion hook")
    const queueFor = (sessionID: string) =>
      openReflectionQueue(
        stateDir,
        JSON.stringify([memoryScope("proj_test", join(dir, "session")), sessionID]),
      )
    await context({
      sessionID: "outside",
      messages: [{ role: "user", content: [{ type: "text", text: "leaked" }] }],
    })
    expect(queueFor("outside").inspect().pending).toEqual([])
    await context({
      sessionID: "alice",
      agent: "build",
      result: { summary: "compaction summary must not be reused" },
      messages: [
        { role: "user", content: [{ type: "text", text: "release checklist" }, { type: "image" }] },
        { role: "assistant", content: [{ type: "text", text: "checklist updated" }] },
      ],
    })
    const state = added.find((tool) => tool.name === "memory_reflection_state")
    if (!state) throw new Error("missing reflection state tool")
    const mine = (await state.execute({}, { sessionID: "alice" })) as { content: string }
    expect(JSON.parse(mine.content).pending).toEqual([
      {
        sessionID: "alice",
        text: "user: release checklist\nassistant: checklist updated",
        trigger: "step",
      },
    ])
    const other = (await state.execute({}, { sessionID: "bob" })) as { content: string }
    expect(other.content).not.toContain("checklist")
    await dispose()
    disposed = true
    expect(hooks.context?.disposed).toBe(true)
    await context({
      sessionID: "alice",
      messages: [{ role: "user", content: [{ type: "text", text: "after unload" }] }],
    })
    expect(queueFor("alice").inspect().pending).toHaveLength(1)
  } finally {
    if (!disposed) await dispose()
    await cleanup()
  }
})

test("compaction ingestion stores a decided summary only for the native session", async () => {
  const { dir, stateDir, cleanup } = await tempDir()
  const { ctx, added, hooks } = fixture(dir)
  const dispose = await mountMemory(ctx, stateDir, true)
  let disposed = false
  try {
    const compaction = hooks.compaction?.handler
    if (!compaction) throw new Error("missing compaction ingestion hook")
    const queueFor = (sessionID: string) =>
      openReflectionQueue(
        stateDir,
        JSON.stringify([memoryScope("proj_test", join(dir, "session")), sessionID]),
      )
    await compaction({ sessionID: "outside", result: { summary: "leaked" } })
    expect(queueFor("outside").inspect().pending).toEqual([])
    await compaction({
      sessionID: "alice",
      result: { summary: "deploys go to staging first" },
      messages: [{ role: "user", content: [{ type: "text", text: "ignored" }] }],
    })
    const state = added.find((tool) => tool.name === "memory_reflection_state")
    if (!state) throw new Error("missing reflection state tool")
    const mine = (await state.execute({}, { sessionID: "alice" })) as { content: string }
    expect(JSON.parse(mine.content).pending).toEqual([
      { sessionID: "alice", text: "deploys go to staging first", trigger: "compaction" },
    ])
    const other = (await state.execute({}, { sessionID: "bob" })) as { content: string }
    expect(other.content).not.toContain("staging")
    // Repeated compaction of identical text coalesces instead of stacking.
    await compaction({ sessionID: "alice", result: { summary: "deploys go to staging first" } })
    expect(queueFor("alice").inspect().pending).toHaveLength(1)
    await dispose()
    disposed = true
    expect(hooks.compaction?.disposed).toBe(true)
    // A handler reference retained after unload must not write durable state.
    await compaction({ sessionID: "alice", result: { summary: "after unload" } })
    expect(queueFor("alice").inspect().pending[0]?.text).toBe("deploys go to staging first")
  } finally {
    if (!disposed) await dispose()
    await cleanup()
  }
})

test("native reflection pipeline persists isolated reservations and rejects foreign settlement", async () => {
  const { dir, stateDir, cleanup } = await tempDir()
  const { ctx, added } = fixture(dir)
  const dispose = await mountMemory(ctx, stateDir, true)
  let disposed = false
  try {
    const pipeline = added.find((tool) => tool.name === "memory_pipeline")
    const state = added.find((tool) => tool.name === "memory_reflection_state")
    expect(pipeline?.options.permission).toBe("edit")
    expect(state?.options.permission).toBe("read")
    if (!pipeline || !state) throw new Error("missing reflection pipeline tools")
    await expect(
      pipeline.execute({ action: "ingest", text: "private", trigger: "manual" }, {}),
    ).rejects.toThrow("native-session-required")
    await expect(state.execute({}, {})).rejects.toThrow("native-session-required")
    await pipeline.execute(
      { action: "ingest", text: "private", trigger: "manual" },
      { sessionID: "alice" },
    )
    const reserved = (await pipeline.execute({ action: "reserve" }, { sessionID: "alice" })) as {
      content: string
    }
    const run = JSON.parse(reserved.content) as {
      id: string
      snapshots: { sessionID: string; text: string }[]
    }
    expect(run.snapshots[0]).toMatchObject({ sessionID: "alice", text: "private" })
    const other = (await state.execute({}, { sessionID: "bob" })) as { content: string }
    expect(other.content).not.toContain("private")
    await expect(
      pipeline.execute(
        { action: "settle", runID: run.id, outcome: "merged" },
        { sessionID: "bob" },
      ),
    ).rejects.toThrow("stale-reservation")
    await pipeline.execute(
      { action: "settle", runID: run.id, outcome: "no_changes" },
      { sessionID: "alice" },
    )
    const committed = (await pipeline.execute(
      { action: "ingest", text: "private", trigger: "step" },
      { sessionID: "alice" },
    )) as { content: string }
    expect(JSON.parse(committed.content)).toEqual({ queued: false })
    await dispose()
    disposed = true
    await expect(state.execute({}, { sessionID: "alice" })).rejects.toThrow()
  } finally {
    if (!disposed) await dispose()
    await cleanup()
  }
})

test.each(
  [
    "memory_save",
    "memory_recall",
    "memory_reflect",
    "memory_pipeline",
    "memory_reflection_state",
    "memory_commit",
  ].flatMap((name) =>
    (["project", "location", "identity"] as const).map((foreign) => [name, foreign] as const),
  ),
)(
  "%s refuses missing and foreign %s native callers before accessing memory",
  async (name, foreignScope) => {
    const { dir, stateDir, cleanup } = await tempDir()
    const local = fixture(dir)
    const foreign = fixture(dir, foreignScope)
    const disposeLocal = await mountMemory(local.ctx, stateDir, true)
    const disposeForeign = await mountMemory(foreign.ctx, stateDir, true)
    const input = {
      content: "private release information",
      query: "private",
      kind: "fact",
      summary: "private reflection",
    }
    try {
      const tool = local.added.find((item) => item.name === name)
      const foreignTool = foreign.added.find((item) => item.name === name)
      const recall = local.added.find((item) => item.name === "memory_recall")
      if (!tool || !foreignTool || !recall) throw new Error("missing memory tools")
      await expect(tool.execute(input, {})).rejects.toThrow("native-session-required")
      await expect(foreignTool.execute(input, { sessionID: "foreign" })).rejects.toThrow(
        "foreign-session",
      )
      const result = (await recall.execute(
        { query: "private", reflections: true },
        { sessionID: "self" },
      )) as { output: string }
      expect(result.output).not.toContain("private release information")
      expect(result.output).not.toContain("private reflection")
    } finally {
      await disposeForeign()
      await disposeLocal()
      await cleanup()
    }
  },
)

test("mountMemory registers save and recall tools only when enabled", async () => {
  const { dir, stateDir, cleanup } = await tempDir()
  let disposed = false
  let disposeEnabled: (() => Promise<void>) | undefined
  try {
    const enabled = fixture(dir)
    disposeEnabled = await mountMemory(enabled.ctx, stateDir, true)
    expect(enabled.added.map((tool) => tool.name).sort()).toEqual([
      "memory_commit",
      "memory_pipeline",
      "memory_recall",
      "memory_reflect",
      "memory_reflection_state",
      "memory_save",
    ])
    const saveTool = enabled.added.find((tool) => tool.name === "memory_save")
    const recallTool = enabled.added.find((tool) => tool.name === "memory_recall")
    const reflectTool = enabled.added.find((tool) => tool.name === "memory_reflect")
    expect(saveTool?.options).toEqual({ namespace: "omo", permission: "edit" })
    expect(recallTool?.options).toEqual({ namespace: "omo", permission: "read" })
    expect(reflectTool?.options).toEqual({ namespace: "omo", permission: "edit" })
    await disposeEnabled()
    disposed = true

    const disabled = fixture(dir)
    const disposeDisabled = await mountMemory(disabled.ctx, stateDir, false)
    expect(disabled.added).toHaveLength(0)
    await disposeDisabled()
  } finally {
    // Without this, a Windows handle left open masks the real failure as EBUSY.
    if (!disposed) await disposeEnabled?.()
    await cleanup()
  }
})

test("the dream trigger arms after an idle gap through the real wiring", async () => {
  const { dir, stateDir, cleanup } = await tempDir()
  const { ctx, added, hooks } = fixture(dir)
  const dispose = await mountMemory(ctx, stateDir, true)
  let disposed = false
  const T0 = new Date("2026-10-09T13:00:00.000Z")
  try {
    setSystemTime(T0)
    const context = hooks.context?.handler
    const pipeline = added.find((tool) => tool.name === "memory_pipeline")
    const state = added.find((tool) => tool.name === "memory_reflection_state")
    if (!context || !pipeline || !state) throw new Error("missing dream wiring")
    const triggerEnum = (pipeline.input as { properties: { trigger: { enum: string[] } } })
      .properties.trigger.enum
    expect(triggerEnum).toEqual(["manual", "compaction", "step", "dream"])

    const messages = [{ role: "user", content: [{ type: "text", text: "steady conversation" }] }]

    // First observation only records the baseline: nothing is armed yet.
    await context({ sessionID: "alice", messages })
    const before = (await state.execute({}, { sessionID: "alice" })) as { content: string }
    expect(JSON.parse(before.content).dream).toEqual({
      due: false,
      reason: "no-idle-gap",
      activityAt: T0.getTime(),
      dreamAt: null,
      dreamDue: false,
    })

    // Dreaming before any idle gap is refused with the exact reason, and the
    // refusal reaches the caller instead of silently skipping.
    await expect(
      pipeline.execute(
        { action: "ingest", trigger: "dream", text: "consolidate the day" },
        { sessionID: "alice" },
      ),
    ).rejects.toThrow("dream-no-idle-gap")

    // Settle the step so the queue is clean before the dream arrives.
    const reserved = (await pipeline.execute({ action: "reserve" }, { sessionID: "alice" })) as {
      content: string
    }
    const run = JSON.parse(reserved.content) as { id: string }
    await pipeline.execute(
      { action: "settle", runID: run.id, outcome: "no_changes" },
      { sessionID: "alice" },
    )

    // Returning 31 minutes later with unchanged text: the enqueue deduplicates,
    // yet the observation arms the trigger — idle is about time, not new text.
    const returned = new Date(T0.getTime() + 31 * 60_000)
    setSystemTime(returned)
    await context({ sessionID: "alice", messages })
    const armed = JSON.parse(
      ((await state.execute({}, { sessionID: "alice" })) as { content: string }).content,
    ) as { dream: { due: boolean }; pending: unknown[] }
    expect(armed.dream.due).toBe(true)
    expect(armed.pending).toEqual([])

    // The dream queues and spends the flag in one honest report.
    const dream = (await pipeline.execute(
      { action: "ingest", trigger: "dream", text: "consolidate the day" },
      { sessionID: "alice" },
    )) as { content: string }
    expect(JSON.parse(dream.content)).toEqual({ queued: true })
    const after = JSON.parse(
      ((await state.execute({}, { sessionID: "alice" })) as { content: string }).content,
    ) as { dream: Record<string, unknown>; pending: unknown[] }
    expect(after.dream).toEqual({
      due: false,
      reason: "no-idle-gap",
      activityAt: returned.getTime(),
      dreamAt: returned.getTime(),
      dreamDue: false,
    })
    expect(after.pending).toEqual([
      { sessionID: "alice", text: "consolidate the day", trigger: "dream" },
    ])
    await dispose()
    disposed = true
  } finally {
    setSystemTime()
    if (!disposed) await dispose()
    await cleanup()
  }
})

test("a disabled dream configuration refuses the dream trigger and keeps the other tools working", async () => {
  const { dir, stateDir, cleanup } = await tempDir()
  const { ctx, added } = fixture(dir)
  const dispose = await mountMemory(ctx, stateDir, true, {
    enabled: false,
    idleMinutes: 30,
    minHoursBetween: 24,
  })
  try {
    const pipeline = added.find((tool) => tool.name === "memory_pipeline")
    const state = added.find((tool) => tool.name === "memory_reflection_state")
    if (!pipeline || !state) throw new Error("missing tools")
    await expect(
      pipeline.execute(
        { action: "ingest", trigger: "dream", text: "consolidate" },
        { sessionID: "alice" },
      ),
    ).rejects.toThrow("dream-disabled")
    const reported = (await state.execute({}, { sessionID: "alice" })) as { content: string }
    expect(JSON.parse(reported.content).dream).toEqual({
      due: false,
      reason: "disabled",
      activityAt: null,
      dreamAt: null,
      dreamDue: false,
    })
    const queued = (await pipeline.execute(
      { action: "ingest", text: "normal", trigger: "manual" },
      { sessionID: "alice" },
    )) as { content: string }
    expect(JSON.parse(queued.content)).toEqual({ queued: true })
  } finally {
    await dispose()
    await cleanup()
  }
})

test("mountMemory fails closed on a malformed dream configuration before registering anything", async () => {
  const { dir, stateDir, cleanup } = await tempDir()
  const { ctx, added } = fixture(dir)
  try {
    await expect(
      mountMemory(ctx, stateDir, true, { enabled: true, idleMinutes: 0, minHoursBetween: 24 }),
    ).rejects.toThrow("invalid-dream-config")
    expect(added).toHaveLength(0)
  } finally {
    await cleanup()
  }
})

test("memory_save then memory_recall round-trips through the registered tools", async () => {
  const { dir, stateDir, cleanup } = await tempDir()
  const { ctx, added } = fixture(dir)
  const dispose = await mountMemory(ctx, stateDir, true)
  try {
    const saveTool = added.find((tool) => tool.name === "memory_save")
    const recallTool = added.find((tool) => tool.name === "memory_recall")
    if (!saveTool || !recallTool) throw new Error("expected memory_save and memory_recall tools")

    const saved = (await saveTool.execute(
      { content: "release checklist lives in docs/release.md", tags: ["release"] },
      { sessionID: "self" },
    )) as { output: string }
    expect(saved.output).toContain("created")
    expect(saved.output).toContain("release")

    const recalled = (await recallTool.execute({ query: "release" }, { sessionID: "self" })) as {
      output: string
    }
    expect(recalled.output).toContain("docs/release.md")

    const empty = (await recallTool.execute({ query: "qqqq-nothing" }, { sessionID: "self" })) as {
      output: string
    }
    expect(empty.output).toContain("0 match")
  } finally {
    await dispose()
    await cleanup()
  }
})

test("memory_reflect records entries surfaced by recall with reflections=true", async () => {
  const { dir, stateDir, cleanup } = await tempDir()
  const { ctx, added } = fixture(dir)
  const dispose = await mountMemory(ctx, stateDir, true)
  try {
    const recallTool = added.find((tool) => tool.name === "memory_recall")
    const reflectTool = added.find((tool) => tool.name === "memory_reflect")
    if (!recallTool || !reflectTool)
      throw new Error("expected memory_recall and memory_reflect tools")

    const recorded = (await reflectTool.execute(
      { kind: "correction", summary: "staging is the deploy target" },
      { sessionID: "self" },
    )) as { output: string }
    expect(recorded.output).toContain("recorded (correction)")

    const plain = (await recallTool.execute({ query: "staging" }, { sessionID: "self" })) as {
      output: string
    }
    expect(plain.output).not.toContain("staging is the deploy target")

    const compiled = (await recallTool.execute(
      { query: "staging", reflections: true },
      { sessionID: "self" },
    )) as {
      output: string
    }
    expect(compiled.output).toContain("## Reflections")
    expect(compiled.output).toContain("staging is the deploy target")

    await expect(
      reflectTool.execute({ kind: "dream", summary: "nope" }, { sessionID: "self" }),
    ).rejects.toThrow()
  } finally {
    await dispose()
    await cleanup()
  }
})
