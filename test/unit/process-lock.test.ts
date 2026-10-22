import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireProjectLock } from "../../src/runtime/lock"

// Host reload overlaps generations in the same process: the supervisor closes
// the old scope only after the replacement is settled, so a same-process lock
// must be taken over, never wedge setup forever. A live foreign process must
// still be rejected without touching its lock.
//
// The lock file is published non-atomically — open(path, "wx") creates it
// empty and the record is written right after — so a concurrent acquirer can
// read an in-flight lock. Unreadable content is retried within the grace
// budget and only fails actionable once it outlives that window.

const DEAD_PID = 2147483647

async function dir() {
  const root = await mkdtemp(join(tmpdir(), "omo lock "))
  return {
    root,
    async dispose() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("acquires a free lock and release is idempotent", async () => {
  const { root, dispose } = await dir()
  try {
    const release = await acquireProjectLock(join(root, "runtime.lock"))
    await release()
    await release()
  } finally {
    await dispose()
  }
})

test("reclaims a lock whose owner process is dead", async () => {
  const { root, dispose } = await dir()
  try {
    const path = join(root, "runtime.lock")
    await writeFile(path, JSON.stringify({ pid: DEAD_PID, token: "dead" }))
    const release = await acquireProjectLock(path)
    const current = JSON.parse(await readFile(path, "utf8")) as { pid: number; token: string }
    expect(current.pid).toBe(process.pid)
    expect(current.token).not.toBe("dead")
    await release()
  } finally {
    await dispose()
  }
})

test("rejects a live foreign owner without touching its lock", async () => {
  const { root, dispose } = await dir()
  try {
    const path = join(root, "runtime.lock")
    const foreign = { pid: process.ppid, token: "foreign-live" }
    await writeFile(path, JSON.stringify(foreign))
    const error = await acquireProjectLock(path, { graceMs: 1 }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("omo-runtime-owned")
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(foreign)
  } finally {
    await dispose()
  }
})

test("takes over a same-process lock left by a previous generation", async () => {
  const { root, dispose } = await dir()
  try {
    const path = join(root, "runtime.lock")
    await writeFile(path, JSON.stringify({ pid: process.pid, token: "previous-generation" }))
    const release = await acquireProjectLock(path, { graceMs: 50 })
    const current = JSON.parse(await readFile(path, "utf8")) as { token: string }
    expect(current.token).not.toBe("previous-generation")
    await release()
  } finally {
    await dispose()
  }
})

test("release never removes a lock owned by someone else", async () => {
  const { root, dispose } = await dir()
  try {
    const path = join(root, "runtime.lock")
    const release = await acquireProjectLock(path)
    const foreign = { pid: process.ppid, token: "foreign-live" }
    await writeFile(path, JSON.stringify(foreign))
    await release()
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(foreign)
  } finally {
    await dispose()
  }
})

test("corrupt lock content fails actionable and preserves the file", async () => {
  const { root, dispose } = await dir()
  try {
    const path = join(root, "runtime.lock")
    await writeFile(path, "{not json")
    const error = await acquireProjectLock(path, { graceMs: 1 }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("omo-runtime-locked")
    expect(await readFile(path, "utf8")).toBe("{not json")
  } finally {
    await dispose()
  }
})

test("waits out a briefly empty lock published by a concurrent runtime", async () => {
  const { root, dispose } = await dir()
  try {
    const path = join(root, "runtime.lock")
    await writeFile(path, "")
    const foreign = { pid: process.ppid, token: "foreign-live" }
    const publish = setTimeout(() => {
      writeFile(path, JSON.stringify(foreign)).catch(() => {})
    }, 30)
    const error = await acquireProjectLock(path, { graceMs: 500, pollMs: 10 }).catch(
      (cause: unknown) => cause,
    )
    clearTimeout(publish)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("omo-runtime-owned")
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(foreign)
  } finally {
    await dispose()
  }
})

test("an unreadable lock that never settles fails actionable after the grace window", async () => {
  const { root, dispose } = await dir()
  try {
    const path = join(root, "runtime.lock")
    await writeFile(path, "")
    const error = await acquireProjectLock(path, { graceMs: 80, pollMs: 10 }).catch(
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("omo-runtime-locked")
    expect(await readFile(path, "utf8")).toBe("")
  } finally {
    await dispose()
  }
})
