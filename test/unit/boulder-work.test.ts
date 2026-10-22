import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openBoulderStore } from "../../src/boulder/store"

async function stateHome() {
  const stateDir = await mkdtemp(join(tmpdir(), "omo-boulder-work-"))
  await writeFile(join(stateDir, "plan.md"), "- [ ] Ship\n")
  await writeFile(join(stateDir, "other.md"), "- [x] Done\n")
  return { stateDir, cleanup: () => rm(stateDir, { recursive: true, force: true }) }
}

test("a session tracks several works and each keeps its own plan progress", async () => {
  const { stateDir, cleanup } = await stateHome()
  try {
    const store = openBoulderStore(stateDir)
    const first = store.start("owner", "plan.md")
    const second = store.start("owner", "other.md")
    expect(first.id).not.toBe(second.id)
    expect(store.list("owner").map((work) => work.id)).toEqual([first.id, second.id])
    // The newest non-terminal work is the implicit target of status transitions.
    expect(store.get("owner")?.id).toBe(second.id)
    expect(store.transition("owner", "completed")?.id).toBe(second.id)
    // Completing the newest work falls back to the previous unfinished work.
    expect(store.get("owner")?.id).toBe(first.id)
    expect(store.progress("owner", first.id)?.remaining).toBe(1)
    expect(store.progress("owner", second.id)?.remaining).toBe(0)
    expect(store.progress("owner", "unknown-work")).toBeNull()
    expect(store.get("owner", "unknown-work")).toBeNull()
    expect(store.transition("owner", "active", "unknown-work")).toBeNull()
  } finally {
    await cleanup()
  }
})

test("a swept work keeps its stale marker through a transition so recovery stays reachable", async () => {
  const { stateDir, cleanup } = await stateHome()
  try {
    let now = 1_000_000
    const store = openBoulderStore(stateDir, { now: () => now, staleAfterMs: 1_000 })
    const work = store.start("owner", "plan.md")
    now += 5_000
    expect(store.sweep("owner")).toEqual([work.id])
    expect(store.get("owner", work.id)?.stale).toBe(true)
    // Only an explicit `recover` may clear the marker: a status change must not.
    expect(store.transition("owner", "paused", work.id)?.stale).toBe(true)
    expect(store.get("owner", work.id)?.stale).toBe(true)
    expect(() => store.recover("owner", work.id, "resume")).not.toThrow()
    expect(store.get("owner", work.id)?.stale).toBeUndefined()
    now += 5_000
    expect(store.sweep("owner")).toEqual([work.id])
    expect(store.recover("owner", work.id, "abandon")?.status).toBe("abandoned")
    expect(store.get("owner", work.id)?.stale).toBeUndefined()
  } finally {
    await cleanup()
  }
})

test("a handoff only exposes work to the invited session and never implicitly", async () => {
  const { stateDir, cleanup } = await stateHome()
  try {
    const owner = openBoulderStore(stateDir)
    const work = owner.start("owner", "plan.md")
    expect(owner.list("invitee")).toEqual([])
    expect(owner.invitations("invitee")).toEqual([])
    expect(() => owner.offer("owner", work.id, " ")).toThrow("native-session-required")
    expect(() => owner.offer("owner", "unknown-work", "invitee")).toThrow("unknown-work")
    expect(() => owner.offer("owner", work.id, "owner")).toThrow("self-handoff")
    owner.offer("owner", work.id, "invitee")
    expect(owner.invitations("invitee")).toEqual([
      expect.objectContaining({ workID: work.id, fromSessionID: "owner", state: "offered" }),
    ])
    expect(owner.invitations("bystander")).toEqual([])
    expect(owner.list("invitee")).toEqual([])
    expect(() => owner.claim("bystander", work.id)).toThrow("no-handoff")
    const claimed = owner.claim("invitee", work.id)
    expect(claimed.sessionID).toBe("invitee")
    expect(claimed.plan).toBe("plan.md")
    expect(claimed.handedOffFrom).toBe("owner")
    expect(owner.list("invitee").map((item) => item.id)).toEqual([work.id])
    // Ownership moves: leaving a copy behind would create two independently
    // owned live works that both the offerer and the claimer could sweep.
    expect(owner.list("owner").map((item) => item.id)).toEqual([])
    expect(owner.get("owner", work.id)).toBeNull()
    expect(owner.invitations("invitee")[0]?.state).toBe("claimed")
    expect(() => owner.claim("invitee", work.id)).toThrow("handoff-claimed")
  } finally {
    await cleanup()
  }
})

test("stale works are flagged without changing status and need explicit recovery", async () => {
  const { stateDir, cleanup } = await stateHome()
  try {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const clock = () => now
    const store = openBoulderStore(stateDir, { now: clock, staleAfterMs: 1000 })
    const work = store.start("owner", "plan.md")
    const terminal = store.start("owner", "other.md")
    store.transition("owner", "completed", terminal.id)
    now += 5000
    expect(store.sweep("owner", { liveSessions: ["owner"] })).toEqual([])
    expect(store.sweep("owner", { liveSessions: [] })).toEqual([work.id])
    expect(store.get("owner", work.id)?.stale).toBe(true)
    expect(store.get("owner", work.id)?.status).toBe("active")
    expect(store.get("owner", terminal.id)?.stale).toBeUndefined()
    expect(store.get("bystander", work.id)).toBeNull()
    // Recovery only applies to a stale work, and only with a known disposition.
    expect(() =>
      store.recover("owner", work.id, "retry" as Parameters<typeof store.recover>[2]),
    ).toThrow("invalid-recovery-disposition")
    expect(store.recover("owner", "unknown-work", "resume")).toBeNull()
    now += 1000
    const resumed = store.recover("owner", work.id, "resume")
    expect(resumed?.stale).toBeUndefined()
    expect(resumed?.updatedAt).toBe(new Date(now).toISOString())
    // A healthy work is never "recovered"; only stale work is.
    expect(() => store.recover("owner", work.id, "resume")).toThrow("stale-work-required")
    now += 5000
    store.sweep("owner", { liveSessions: [] })
    expect(() => store.recover("owner", work.id, "abandon")).not.toThrow()
    expect(store.get("owner", work.id)?.status).toBe("abandoned")
    expect(() => store.recover("owner", work.id, "resume")).toThrow("terminal-work")
  } finally {
    await cleanup()
  }
})

test("boulder refuses corrupt multi-work records and unknown handoff state", async () => {
  const { stateDir, cleanup } = await stateHome()
  try {
    const store = openBoulderStore(stateDir)
    const work = store.start("owner", "plan.md")
    store.offer("owner", work.id, "invitee")
    expect(() => store.claim("invitee", work.id)).not.toThrow()
    const target = join(
      stateDir,
      "boulder",
      `${createHash("sha256").update("invitee").digest("hex")}.json`,
    )
    const current = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>
    expect(store.list("invitee")).toHaveLength(1)
    await writeFile(target, JSON.stringify({ ...current, invitations: "broken" }))
    expect(() => store.list("invitee")).toThrow("invalid-work-state")
    await writeFile(
      target,
      JSON.stringify({
        ...current,
        invitations: [{ workID: work.id, fromSessionID: "owner", at: "now", state: "unknown" }],
      }),
    )
    expect(() => store.claim("invitee", work.id)).toThrow("invalid-work-state")
    await writeFile(target, JSON.stringify({ version: 2, works: [{ version: 1, id: work.id }] }))
    expect(() => store.list("invitee")).toThrow("invalid-work-state")
  } finally {
    await cleanup()
  }
})
