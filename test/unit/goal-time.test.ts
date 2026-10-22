import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openGoalStore } from "../../src/goal/store"

const session = "ses_time"

/** Wall-clock is injected so active time is measured, not waited out. */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-time-"))
  let now = 1_000_000
  const store = openGoalStore(dir, { now: () => now })
  return {
    store,
    dir,
    advance: (ms: number) => {
      now += ms
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

test("active time accrues on pause, resume and completion", async () => {
  const f = await fixture()
  try {
    expect(f.store.set(session, "ship release")?.status).toBe("active")
    expect(f.store.get(session)?.timeUsedSeconds).toBe(0)
    f.advance(5_000)
    expect(f.store.pause(session)?.timeUsedSeconds).toBe(5)
    f.advance(60_000)
    // Paused time is not counted, and resuming starts a new active interval.
    expect(f.store.resume(session)?.timeUsedSeconds).toBe(5)
    f.advance(2_000)
    expect(f.store.complete(session)?.timeUsedSeconds).toBe(7)
    f.advance(9_000)
    expect(f.store.get(session)?.timeUsedSeconds).toBe(7)
  } finally {
    await f.cleanup()
  }
})

test("cancelling, abandoning and an automatic budget pause all settle active time", async () => {
  const cancelled = await fixture()
  try {
    cancelled.store.set(session, "first")
    cancelled.advance(4_000)
    expect(cancelled.store.cancel(session)?.timeUsedSeconds).toBe(4)
    cancelled.advance(3_000)
    expect(cancelled.store.cancel(session)?.timeUsedSeconds).toBe(4)
  } finally {
    await cancelled.cleanup()
  }
  const abandoned = await fixture()
  try {
    abandoned.store.set(session, "first")
    abandoned.advance(6_000)
    abandoned.store.noteContinuation(session)
    expect(abandoned.store.recoverContinuation(session, "abandon")?.timeUsedSeconds).toBe(6)
  } finally {
    await abandoned.cleanup()
  }
  const breached = await fixture()
  try {
    breached.store.set(session, "first", { maxCost: 1 })
    breached.advance(7_000)
    breached.store.accrueSnapshot(session, {
      cost: 0.5,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    breached.advance(5_000)
    breached.store.accrueSnapshot(session, {
      cost: 4,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const goal = breached.store.get(session)
    expect(goal?.status).toBe("paused")
    expect(goal?.timeUsedSeconds).toBe(12)
    breached.advance(8_000)
    expect(breached.store.get(session)?.timeUsedSeconds).toBe(12)
  } finally {
    await breached.cleanup()
  }
})

test("a corrupted active interval reads as no goal instead of silently discarded time", async () => {
  const f = await fixture()
  try {
    f.store.set(session, "ship release")
    // The goal store writes `<dir>/<sessionID>.json` (URI-encoded session id).
    const file = join(f.dir, `${session}.json`)
    const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    // A damaged record must read as absent (the documented fail-closed
    // contract), never as a goal with a silently wrong active interval.
    for (const activeSince of [null, "soon", Number.NaN]) {
      await writeFile(
        file,
        JSON.stringify({
          ...record,
          ...(activeSince === null ? { status: "paused" } : {}),
          activeSince,
        }),
      )
      expect(f.store.get(session)).toBeNull()
    }
  } finally {
    await f.cleanup()
  }
})
