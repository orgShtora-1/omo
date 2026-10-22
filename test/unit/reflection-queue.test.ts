import { Database } from "bun:sqlite"
import { expect, setSystemTime, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openReflectionQueue } from "../../src/memory/reflection-queue"

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "omo-reflection-"))
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test("successful cursor retention evicts the least recently settled conversation across reopen", async () => {
  const { directory, cleanup } = await fixture()
  try {
    const queue = openReflectionQueue(directory, "scope", { cursors: 2 })
    const settle = (sessionID: string) => {
      queue.enqueue({ sessionID, text: sessionID, trigger: "manual" })
      const run = queue.reserve()
      if (!run) throw new Error("missing reservation")
      queue.settle(run.id, "no_changes")
    }
    settle("10")
    settle("2")
    // A changed snapshot refreshes settlement recency, not numeric key order.
    queue.enqueue({ sessionID: "10", text: "refreshed", trigger: "manual" })
    const refresh = queue.reserve()
    if (!refresh) throw new Error("missing refresh")
    queue.settle(refresh.id, "merged")
    settle("3")
    const reopened = openReflectionQueue(directory, "scope", { cursors: 2 })
    expect(reopened.enqueue({ sessionID: "10", text: "refreshed", trigger: "step" })).toBe(false)
    expect(reopened.enqueue({ sessionID: "3", text: "3", trigger: "step" })).toBe(false)
    expect(reopened.enqueue({ sessionID: "2", text: "2", trigger: "step" })).toBe(true)
    const db = new Database(join(directory, "reflection-queue.sqlite"), { readonly: true })
    try {
      const row = db.query("SELECT state FROM reflection_queue WHERE scope = ?").get("scope") as {
        state: string
      }
      expect(Object.keys(JSON.parse(row.state).cursors)).toHaveLength(2)
    } finally {
      db.close()
    }
  } finally {
    await cleanup()
  }
})

test.each([
  { active: false, pending: [], cursors: {} },
  { active: null, pending: [], cursors: [] },
  { active: null, pending: [], cursors: { s: "not-a-digest" } },
  { active: { id: "", snapshots: [] }, pending: [], cursors: {} },
  { active: null, pending: [null], cursors: {} },
  {
    active: null,
    pending: [
      { sessionID: "s", text: "first", trigger: "step" },
      { sessionID: "s", text: "duplicate", trigger: "step" },
    ],
    cursors: {},
  },
  { active: null, pending: [], cursors: {}, activityAt: "soon" },
  { active: null, pending: [], cursors: {}, dreamAt: -1 },
  { active: null, pending: [], cursors: {}, dreamDue: "yes" },
])("corrupt reflection records fail closed without rewriting storage: %j", async (state) => {
  const { directory, cleanup } = await fixture()
  try {
    const queue = openReflectionQueue(directory, "scope")
    queue.enqueue({ sessionID: "s", text: "original", trigger: "step" })
    const file = join(directory, "reflection-queue.sqlite")
    const db = new Database(file)
    try {
      db.query("UPDATE reflection_queue SET state = ? WHERE scope = ?").run(
        JSON.stringify(state),
        "scope",
      )
    } finally {
      db.close()
    }
    const before = await readFile(file)
    expect(() => queue.inspect()).toThrow("invalid-reflection-state")
    expect(() => queue.reserve()).toThrow("invalid-reflection-state")
    expect(() => queue.dreamState()).toThrow("invalid-reflection-state")
    expect(await readFile(file)).toEqual(before)
  } finally {
    await cleanup()
  }
})

test("reflection inspection neither creates storage nor changes existing database bytes", async () => {
  const { directory, cleanup } = await fixture()
  try {
    const empty = openReflectionQueue(directory, "empty")
    expect(empty.inspect()).toEqual({ active: null, pending: [] })
    expect(await readdir(directory)).toEqual([])
    const writer = openReflectionQueue(directory, "writer")
    writer.enqueue({ sessionID: "s", text: "retained", trigger: "manual" })
    const file = join(directory, "reflection-queue.sqlite")
    const before = await readFile(file)
    expect(openReflectionQueue(directory, "reader").inspect()).toEqual({
      active: null,
      pending: [],
    })
    expect(writer.inspect().pending).toEqual([
      { sessionID: "s", text: "retained", trigger: "manual" },
    ])
    expect(await readFile(file)).toEqual(before)
  } finally {
    await cleanup()
  }
})

test("reflection reservation survives reopening and requires explicit recovery", async () => {
  const { directory, cleanup } = await fixture()
  try {
    const queue = openReflectionQueue(directory, "project-a")
    expect(queue.enqueue({ sessionID: "s", text: "snapshot", trigger: "step" })).toBe(true)
    const run = queue.reserve()
    expect(run?.snapshots).toEqual([{ sessionID: "s", text: "snapshot", trigger: "step" }])
    if (!run) throw new Error("missing reservation")
    const reopened = openReflectionQueue(directory, "project-a")
    expect(reopened.reserve()).toBeNull()
    expect(reopened.inspect().active?.id).toBe(run.id)
    reopened.recover(run.id)
    const retry = reopened.reserve()
    expect(retry?.id).not.toBe(run.id)
    expect(retry?.snapshots).toEqual(run.snapshots)
    expect(openReflectionQueue(directory, "project-b").inspect().active).toBeNull()
  } finally {
    await cleanup()
  }
})

test.each(["merged", "no_changes"] as const)(
  "%s commits only reserved snapshots and leaves later changes queued",
  async (outcome) => {
    const { directory, cleanup } = await fixture()
    try {
      const queue = openReflectionQueue(directory, "scope")
      queue.enqueue({ sessionID: "s", text: "old", trigger: "step" })
      const run = queue.reserve()
      if (!run) throw new Error("missing reservation")
      queue.enqueue({ sessionID: "s", text: "new", trigger: "manual" })
      expect(() => queue.settle("foreign-run", outcome)).toThrow("stale-reservation")
      queue.settle(run.id, outcome)
      expect(queue.inspect().pending).toEqual([{ sessionID: "s", text: "new", trigger: "manual" }])
      expect(queue.enqueue({ sessionID: "s", text: "old", trigger: "step" })).toBe(false)
      const next = queue.reserve()
      if (!next) throw new Error("missing next reservation")
      queue.settle(next.id, outcome)
      expect(
        openReflectionQueue(directory, "scope").enqueue({
          sessionID: "s",
          text: "new",
          trigger: "step",
        }),
      ).toBe(false)
    } finally {
      await cleanup()
    }
  },
)

test("failed reflection retains retryable snapshots but never replaces a newer pending snapshot", async () => {
  const { directory, cleanup } = await fixture()
  try {
    const queue = openReflectionQueue(directory, "scope")
    queue.enqueue({ sessionID: "s", text: "old", trigger: "step" })
    queue.enqueue({ sessionID: "t", text: "retained", trigger: "compaction" })
    const run = queue.reserve()
    if (!run) throw new Error("missing reservation")
    queue.enqueue({ sessionID: "s", text: "new", trigger: "manual" })
    queue.settle(run.id, "failed")
    expect(queue.inspect().active).toBeNull()
    expect(queue.reserve()?.snapshots).toEqual([
      { sessionID: "s", text: "new", trigger: "manual" },
      { sessionID: "t", text: "retained", trigger: "compaction" },
    ])
  } finally {
    await cleanup()
  }
})

test("queue enforces conversation and UTF8 byte bounds without changing durable state", async () => {
  const { directory, cleanup } = await fixture()
  try {
    const queue = openReflectionQueue(directory, "scope", { conversations: 1, bytes: 4 })
    queue.enqueue({ sessionID: "s", text: "ok", trigger: "step" })
    expect(() => queue.enqueue({ sessionID: "t", text: "x", trigger: "step" })).toThrow(
      "reflection-limit",
    )
    expect(() => queue.enqueue({ sessionID: "s", text: "ééé", trigger: "manual" })).toThrow(
      "reflection-limit",
    )
    expect(
      openReflectionQueue(directory, "scope", { conversations: 1, bytes: 4 }).inspect().pending,
    ).toEqual([{ sessionID: "s", text: "ok", trigger: "step" }])
  } finally {
    await cleanup()
  }
})

test("pending snapshots coalesce latest text and highest trigger priority", async () => {
  const { directory, cleanup } = await fixture()
  try {
    const queue = openReflectionQueue(directory, "scope")
    queue.enqueue({ sessionID: "s", text: "first", trigger: "manual" })
    queue.enqueue({ sessionID: "s", text: "latest", trigger: "step" })
    expect(queue.reserve()?.snapshots).toEqual([
      { sessionID: "s", text: "latest", trigger: "manual" },
    ])
  } finally {
    await cleanup()
  }
})

const DREAM_T0 = new Date("2026-10-09T12:00:00.000Z")
const dreamMinutes = (n: number) => new Date(DREAM_T0.getTime() + n * 60_000)

test("dream refuses before an idle gap, arms from the previous activity, and spends the flag once", async () => {
  const { directory, cleanup } = await fixture()
  try {
    setSystemTime(DREAM_T0)
    const queue = openReflectionQueue(directory, "scope")
    // The first observation only establishes the baseline activity timestamp.
    expect(queue.enqueue({ sessionID: "s", text: "conversation", trigger: "step" })).toBe(true)
    expect(queue.dreamState()).toEqual({
      activityAt: DREAM_T0.getTime(),
      dreamAt: null,
      dreamDue: false,
    })
    // A dream can never arm its own gap: no prior observation, no dream.
    expect(() =>
      queue.enqueue({ sessionID: "s", text: "dream material", trigger: "dream" }),
    ).toThrow("dream-no-idle-gap")
    const run = queue.reserve()
    if (!run) throw new Error("missing reservation")
    queue.settle(run.id, "no_changes")

    // 31 minutes later the unchanged conversation is re-observed. The enqueue is
    // deduplicated against the settled cursor, yet the observation still arms
    // the trigger — that is the point: idle is about time, not about new text.
    setSystemTime(dreamMinutes(31))
    expect(queue.enqueue({ sessionID: "s", text: "conversation", trigger: "step" })).toBe(false)
    expect(queue.dreamState()).toEqual({
      activityAt: dreamMinutes(31).getTime(),
      dreamAt: null,
      dreamDue: true,
    })
    expect(queue.inspect().pending).toEqual([])

    // Armed: the dream queues and spends the flag.
    expect(queue.enqueue({ sessionID: "s", text: "dream material", trigger: "dream" })).toBe(true)
    expect(queue.inspect().pending).toEqual([
      { sessionID: "s", text: "dream material", trigger: "dream" },
    ])
    expect(queue.dreamState()).toEqual({
      activityAt: dreamMinutes(31).getTime(),
      dreamAt: dreamMinutes(31).getTime(),
      dreamDue: false,
    })
  } finally {
    setSystemTime()
    await cleanup()
  }
})

test("the dream cadence blocks a second dream until the hours elapse and the owed flag survives", async () => {
  const { directory, cleanup } = await fixture()
  try {
    setSystemTime(DREAM_T0)
    const queue = openReflectionQueue(directory, "scope")
    queue.enqueue({ sessionID: "s", text: "conversation", trigger: "step" })
    const first = queue.reserve()
    if (!first) throw new Error("missing reservation")
    queue.settle(first.id, "no_changes")
    // Arm and dream once.
    setSystemTime(dreamMinutes(31))
    expect(queue.enqueue({ sessionID: "s", text: "conversation", trigger: "step" })).toBe(false)
    expect(queue.enqueue({ sessionID: "s", text: "dream material", trigger: "dream" })).toBe(true)

    // A second idle gap arms again 31 minutes after the first dream, but the
    // 24 hour cadence refuses — and the refusal must not spend the flag.
    setSystemTime(dreamMinutes(62))
    expect(queue.enqueue({ sessionID: "s", text: "conversation", trigger: "step" })).toBe(false)
    expect(() => queue.enqueue({ sessionID: "s", text: "second dream", trigger: "dream" })).toThrow(
      "dream-too-soon",
    )
    expect(queue.dreamState()).toEqual({
      activityAt: dreamMinutes(62).getTime(),
      dreamAt: dreamMinutes(31).getTime(),
      dreamDue: true,
    })

    // The owed dream is still owed after the cadence elapses: no further idle
    // observation is needed because the refusal never consumed the flag.
    setSystemTime(dreamMinutes(31 + 24 * 60 + 1))
    expect(queue.enqueue({ sessionID: "s", text: "second dream", trigger: "dream" })).toBe(true)
    expect(queue.inspect().pending).toEqual([
      { sessionID: "s", text: "second dream", trigger: "dream" },
    ])
  } finally {
    setSystemTime()
    await cleanup()
  }
})

test("a disabled dream configuration refuses the dream trigger and never arms from a gap", async () => {
  const { directory, cleanup } = await fixture()
  try {
    setSystemTime(DREAM_T0)
    const queue = openReflectionQueue(directory, "scope", undefined, {
      enabled: false,
      idleMinutes: 30,
      minHoursBetween: 24,
    })
    queue.enqueue({ sessionID: "s", text: "conversation", trigger: "step" })
    setSystemTime(dreamMinutes(31))
    queue.enqueue({ sessionID: "s", text: "conversation", trigger: "step" })
    expect(queue.dreamState().dreamDue).toBe(false)
    expect(() =>
      queue.enqueue({ sessionID: "s", text: "dream material", trigger: "dream" }),
    ).toThrow("dream-disabled")
  } finally {
    setSystemTime()
    await cleanup()
  }
})

test("an open queue validates its dream configuration instead of half-applying it", async () => {
  const { directory, cleanup } = await fixture()
  try {
    expect(() =>
      openReflectionQueue(directory, "scope", undefined, {
        enabled: true,
        idleMinutes: 0,
        minHoursBetween: 24,
      }),
    ).toThrow("invalid-dream-config")
    expect(() =>
      openReflectionQueue(directory, "scope", undefined, {
        enabled: true,
        idleMinutes: 30,
        minHoursBetween: -1,
      }),
    ).toThrow("invalid-dream-config")
    expect(() =>
      openReflectionQueue(directory, "scope", undefined, { enabled: "yes" } as never),
    ).toThrow("invalid-dream-config")
  } finally {
    await cleanup()
  }
})

test("dream inspection reads normalized timestamps without creating storage", async () => {
  const { directory, cleanup } = await fixture()
  try {
    const empty = openReflectionQueue(directory, "empty")
    expect(empty.dreamState()).toEqual({ activityAt: null, dreamAt: null, dreamDue: false })
    expect(await readdir(directory)).toEqual([])
    setSystemTime(DREAM_T0)
    const writer = openReflectionQueue(directory, "writer")
    writer.enqueue({ sessionID: "s", text: "retained", trigger: "manual" })
    const file = join(directory, "reflection-queue.sqlite")
    const before = await readFile(file)
    expect(openReflectionQueue(directory, "writer").dreamState()).toEqual({
      activityAt: DREAM_T0.getTime(),
      dreamAt: null,
      dreamDue: false,
    })
    expect(await readFile(file)).toEqual(before)
  } finally {
    setSystemTime()
    await cleanup()
  }
})

test("dream snapshots sort last when reserved and yield to a manual snapshot", async () => {
  const { directory, cleanup } = await fixture()
  try {
    setSystemTime(DREAM_T0)
    const queue = openReflectionQueue(directory, "scope")
    queue.enqueue({ sessionID: "s1", text: "conversation", trigger: "step" })
    const baseline = queue.reserve()
    if (!baseline) throw new Error("missing reservation")
    queue.settle(baseline.id, "no_changes")
    setSystemTime(dreamMinutes(31))
    expect(queue.enqueue({ sessionID: "s1", text: "conversation", trigger: "step" })).toBe(false)
    expect(queue.enqueue({ sessionID: "s1", text: "dream material", trigger: "dream" })).toBe(true)
    queue.enqueue({ sessionID: "s2", text: "intervening", trigger: "manual" })
    expect(queue.reserve()?.snapshots).toEqual([
      { sessionID: "s2", text: "intervening", trigger: "manual" },
      { sessionID: "s1", text: "dream material", trigger: "dream" },
    ])
  } finally {
    setSystemTime()
    await cleanup()
  }
})

test("a pending dream yields to a manual snapshot coalesced for the same session", async () => {
  const { directory, cleanup } = await fixture()
  try {
    setSystemTime(DREAM_T0)
    const queue = openReflectionQueue(directory, "scope")
    queue.enqueue({ sessionID: "s", text: "conversation", trigger: "step" })
    const baseline = queue.reserve()
    if (!baseline) throw new Error("missing reservation")
    queue.settle(baseline.id, "no_changes")
    setSystemTime(dreamMinutes(31))
    queue.enqueue({ sessionID: "s", text: "conversation", trigger: "step" })
    expect(queue.enqueue({ sessionID: "s", text: "dream material", trigger: "dream" })).toBe(true)
    queue.enqueue({ sessionID: "s", text: "agent's newer text", trigger: "manual" })
    expect(queue.inspect().pending).toEqual([
      { sessionID: "s", text: "agent's newer text", trigger: "manual" },
    ])
  } finally {
    setSystemTime()
    await cleanup()
  }
})
