import { expect, test } from "bun:test"
import { createCompactionIngest, createStepIngest, type IngestDeps } from "../../src/memory/ingest"
import type { ConversationSnapshot } from "../../src/memory/reflection-queue"

function record(overrides: Partial<IngestDeps> = {}) {
  const snapshots: ConversationSnapshot[] = []
  const admitted: string[] = []
  const deps: IngestDeps = {
    maxChars: overrides.maxChars,
    signal: overrides.signal,
    enqueue:
      overrides.enqueue ??
      ((snapshot) => {
        snapshots.push(snapshot)
        return true
      }),
    admit: async (sessionID, signal) => {
      admitted.push(sessionID)
      await overrides.admit?.(sessionID, signal ?? new AbortController().signal)
    },
  }
  return { deps, snapshots, admitted }
}

function harness(overrides: Partial<IngestDeps> = {}) {
  const recorded = record(overrides)
  return { ingest: createCompactionIngest(recorded.deps), ...recorded }
}

function stepHarness(overrides: Partial<IngestDeps> = {}) {
  const recorded = record(overrides)
  return { ingest: createStepIngest(recorded.deps), ...recorded }
}

test("a decided compaction summary is ingested as a compaction snapshot", async () => {
  const { ingest, snapshots, admitted } = harness()
  expect(
    await ingest({ sessionID: "s1", result: { summary: "earlier: deploy used staging" } }),
  ).toBe("ingested")
  expect(admitted).toEqual(["s1"])
  expect(snapshots).toEqual([
    { sessionID: "s1", text: "earlier: deploy used staging", trigger: "compaction" },
  ])
})

test("without a decided summary the snapshot is derived from conversation text parts", async () => {
  const { ingest, snapshots } = harness()
  const outcome = await ingest({
    sessionID: "s2",
    result: { summary: "   " },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "prefer tabs" },
          { type: "image", image: "x" },
        ],
      },
      { role: "assistant", content: [{ type: "reasoning", text: "hidden" }] },
      { role: "assistant", content: [{ type: "text", text: "tabs applied" }] },
      { role: "assistant", content: [{ type: "text", text: 42 }] },
      "not-an-object",
    ],
    system: [{ type: "text", text: "system noise" }],
  })
  expect(outcome).toBe("ingested")
  expect(snapshots).toEqual([
    { sessionID: "s2", text: "user: prefer tabs\nassistant: tabs applied", trigger: "compaction" },
  ])
})

test("derived snapshots are bounded by the configured character budget", async () => {
  const { ingest, snapshots } = harness({ maxChars: 12 })
  await ingest({
    sessionID: "s3",
    messages: [{ role: "user", content: [{ type: "text", text: "abcdefghijklmnop" }] }],
  })
  expect(snapshots[0]?.text).toHaveLength(12)
})

test.each([
  { name: "blank session", input: { sessionID: "  " } },
  {
    name: "no durable text",
    input: { sessionID: "s4", messages: [{ role: "user", content: [] }] },
  },
])("compaction ingestion fails closed for $name", async ({ input }) => {
  const { ingest, snapshots, admitted } = harness()
  expect(await ingest(input as { sessionID: string })).toBe("skipped")
  expect(snapshots).toEqual([])
  expect(admitted).toEqual([])
})

test("a session outside the mounted scope is never ingested", async () => {
  const { ingest, snapshots, admitted } = harness({
    admit: async () => {
      throw new Error("foreign-session")
    },
  })
  expect(await ingest({ sessionID: "foreign", result: { summary: "leaked" } })).toBe("skipped")
  expect(admitted).toEqual(["foreign"])
  expect(snapshots).toEqual([])
})

test("an aborted mount stops ingestion before any session lookup", async () => {
  const controller = new AbortController()
  controller.abort()
  const { ingest, snapshots, admitted } = harness({ signal: controller.signal })
  expect(await ingest({ sessionID: "s5", result: { summary: "text" } })).toBe("skipped")
  expect(admitted).toEqual([])
  expect(snapshots).toEqual([])
})

test("queue limits are reported without breaking the host compaction", async () => {
  const { ingest } = harness({
    enqueue: () => {
      throw new Error("reflection-limit")
    },
  })
  expect(await ingest({ sessionID: "s6", result: { summary: "text" } })).toBe("rejected")
})

test("an already reflected snapshot is reported as deduplicated", async () => {
  const { ingest } = harness({ enqueue: () => false })
  expect(await ingest({ sessionID: "s7", result: { summary: "text" } })).toBe("deduplicated")
})

test("a completed step ingests conversation text with the step trigger", async () => {
  const { ingest, snapshots, admitted } = stepHarness()
  expect(
    await ingest({
      sessionID: "s8",
      agent: "build",
      messages: [
        { role: "user", content: [{ type: "text", text: "use pnpm" }] },
        { role: "assistant", content: [{ type: "text", text: "switched to pnpm" }] },
      ],
    }),
  ).toBe("ingested")
  expect(admitted).toEqual(["s8"])
  expect(snapshots).toEqual([
    { sessionID: "s8", text: "user: use pnpm\nassistant: switched to pnpm", trigger: "step" },
  ])
})

test("step ingestion never uses a decided summary and ignores tool-only context", async () => {
  const { ingest, snapshots } = stepHarness()
  expect(
    await ingest({
      sessionID: "s9",
      result: { summary: "compaction summary must not be reused" },
      messages: [{ role: "assistant", content: [{ type: "tool", state: { output: "secret" } }] }],
    }),
  ).toBe("skipped")
  expect(snapshots).toEqual([])
})

test("step ingestion fails closed for blank sessions and aborted mounts", async () => {
  const blank = stepHarness()
  expect(await blank.ingest({ sessionID: "  " })).toBe("skipped")
  expect(blank.admitted).toEqual([])
  const controller = new AbortController()
  controller.abort()
  const aborted = stepHarness({ signal: controller.signal })
  expect(
    await aborted.ingest({
      sessionID: "s10",
      messages: [{ role: "user", content: [{ type: "text", text: "text" }] }],
    }),
  ).toBe("skipped")
  expect(aborted.admitted).toEqual([])
})

test("step ingestion reports foreign sessions and queue limits without throwing", async () => {
  const foreign = stepHarness({
    admit: async () => {
      throw new Error("foreign-session")
    },
  })
  expect(
    await foreign.ingest({
      sessionID: "s11",
      messages: [{ role: "user", content: [{ type: "text", text: "text" }] }],
    }),
  ).toBe("skipped")
  expect(foreign.snapshots).toEqual([])
  const limited = stepHarness({
    enqueue: () => {
      throw new Error("reflection-limit")
    },
  })
  expect(
    await limited.ingest({
      sessionID: "s12",
      messages: [{ role: "user", content: [{ type: "text", text: "text" }] }],
    }),
  ).toBe("rejected")
  const deduplicated = stepHarness({ enqueue: () => false })
  expect(
    await deduplicated.ingest({
      sessionID: "s13",
      messages: [{ role: "user", content: [{ type: "text", text: "text" }] }],
    }),
  ).toBe("deduplicated")
})

test("step ingestion bounds derived text with its own budget", async () => {
  const { ingest, snapshots } = stepHarness({ maxChars: 9 })
  expect(
    await ingest({
      sessionID: "s14",
      messages: [{ role: "user", content: [{ type: "text", text: "abcdefghijklmnop" }] }],
    }),
  ).toBe("ingested")
  expect(snapshots[0]?.text).toBe("user: abc")
})
