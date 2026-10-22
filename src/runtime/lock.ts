import { open, readFile, unlink } from "node:fs/promises"

export interface ProjectLockOptions {
  /** How long a same-process holder gets to release before takeover. Defaults to 2000ms. */
  graceMs?: number
  /** Poll interval while waiting for a same-process release. Defaults to 50ms. */
  pollMs?: number
}

interface LockRecord {
  pid: number
  token: string
  createdAt?: number
  instanceID?: string
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined
}

function isRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.pid === "number" && typeof record.token === "string"
}

async function readRecord(path: string): Promise<LockRecord | "missing" | "corrupt"> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    return isRecord(parsed) ? parsed : "corrupt"
  } catch (error) {
    return codeOf(error) === "ENOENT" ? "missing" : "corrupt"
  }
}

function ownedMessage(record: LockRecord): string {
  const age =
    typeof record.createdAt === "number"
      ? ` held for ${Math.max(0, Math.round((Date.now() - record.createdAt) / 1000))}s`
      : ""
  return (
    `omo-runtime-owned: another runtime (${record.pid}) owns this project${age}; ` +
    "unload it before mounting"
  )
}

function lockedMessage(path: string): string {
  return (
    `omo-runtime-locked: lock at ${path} is unreadable; ` +
    "verify no runtime owns this project, remove it, and retry"
  )
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH means no such process; EPERM means it exists but cannot be signalled.
    return codeOf(error) !== "ESRCH"
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// One runtime per project directory. The host overlaps generations of the same
// process on reload: it settles the replacement before releasing the previous
// scope, so a lock held by this same process must be taken over after a short
// grace period instead of wedging setup forever. A lock held by another live
// process is always rejected; a lock whose owner died is reclaimed. The lock
// file itself is published non-atomically — open(path, "wx") creates it empty
// and the record is written right after — so an unreadable lock is retried
// within the grace budget before it is treated as actionable corruption.
export async function acquireProjectLock(
  path: string,
  options: ProjectLockOptions = {},
): Promise<() => Promise<void>> {
  const graceMs = options.graceMs ?? 2000
  const pollMs = options.pollMs ?? 50
  const token = crypto.randomUUID()
  const instanceID = crypto.randomUUID()
  const unreadableDeadline = Date.now() + graceMs
  for (;;) {
    try {
      const file = await open(path, "wx")
      await file.writeFile(
        JSON.stringify({ pid: process.pid, token, createdAt: Date.now(), instanceID }),
      )
      await file.close()
      return async () => {
        const current = await readRecord(path)
        if (current === "missing" || current === "corrupt") return
        if (current.token !== token) return
        try {
          await unlink(path)
        } catch (error) {
          if (codeOf(error) !== "ENOENT") throw error
        }
      }
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error
    }
    const record = await readRecord(path)
    if (record === "missing") continue
    if (record === "corrupt") {
      if (Date.now() < unreadableDeadline) {
        await sleep(pollMs)
        continue
      }
      throw new Error(lockedMessage(path))
    }
    if (record.pid !== process.pid) {
      if (!isAlive(record.pid)) {
        try {
          await unlink(path)
        } catch (error) {
          if (codeOf(error) !== "ENOENT") throw error
        }
        continue
      }
      throw new Error(ownedMessage(record))
    }
    const deadline = Date.now() + graceMs
    let observed = record.token
    while (Date.now() < deadline) {
      await sleep(pollMs)
      const current = await readRecord(path)
      if (current === "missing") break
      if (current === "corrupt") {
        if (Date.now() < unreadableDeadline) continue
        throw new Error(lockedMessage(path))
      }
      if (current.token !== observed) {
        observed = current.token
        break
      }
    }
    const latest = await readRecord(path)
    if (latest === "missing") continue
    if (latest === "corrupt") {
      if (Date.now() < unreadableDeadline) {
        await sleep(pollMs)
        continue
      }
      throw new Error(lockedMessage(path))
    }
    if (latest.token !== record.token || latest.pid !== process.pid) continue
    try {
      await unlink(path)
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error
    }
  }
}
