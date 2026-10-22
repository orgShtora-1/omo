export type ReflectionTrigger = "manual" | "compaction" | "step" | "dream"
export interface ConversationSnapshot {
  sessionID: string
  text: string
  trigger: ReflectionTrigger
}
interface ReflectionReservation {
  id: string
  snapshots: ConversationSnapshot[]
}
/** Normalized dream bookkeeping read for the reflection-state report. */
interface DreamObservation {
  activityAt: number | null
  dreamAt: number | null
  dreamDue: boolean
}
export interface ReflectionQueue {
  enqueue(snapshot: ConversationSnapshot): boolean
  reserve(): ReflectionReservation | null
  settle(id: string, outcome: "merged" | "no_changes" | "failed"): void
  recover(id: string): void
  inspect(): { active: ReflectionReservation | null; pending: ConversationSnapshot[] }
  dreamState(): DreamObservation
}
export function openReflectionQueue(
  directory: string,
  scope: string,
  limits?: { conversations?: number; bytes?: number; cursors?: number },
  dream?: DreamConfig,
): ReflectionQueue {
  const conversations = limits?.conversations ?? 32
  const bytes = limits?.bytes ?? 4 * 1024 * 1024
  const cursors = limits?.cursors ?? 1024
  if (
    !scope.trim() ||
    !Number.isSafeInteger(conversations) ||
    conversations < 1 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    !Number.isSafeInteger(cursors) ||
    cursors < 1
  )
    throw new Error("invalid-reflection-options")
  const file = join(directory, "reflection-queue.sqlite")
  // A half-parsed dream policy would silently disable or over-enable the
  // trigger, so it is validated once, at open, and fails closed.
  const dreamConfig = validateDreamConfig(dream)
  type State = {
    active: ReflectionReservation | null
    pending: ConversationSnapshot[]
    cursors: Record<string, string>
    cursorOrder?: string[]
    activityAt?: number
    dreamAt?: number
    dreamDue?: boolean
  }
  const digest = (text: string) => createHash("sha256").update(text).digest("hex")
  // Dream ranks below every event-driven trigger: an opportunistic background
  // reflection always yields to work that a host event actually decided.
  const priority: Record<ReflectionTrigger, number> = {
    dream: -1,
    step: 0,
    compaction: 1,
    manual: 2,
  }
  function validate(snapshot: ConversationSnapshot) {
    if (
      !snapshot ||
      typeof snapshot.sessionID !== "string" ||
      !snapshot.sessionID.trim() ||
      typeof snapshot.text !== "string" ||
      !Object.hasOwn(priority, snapshot.trigger)
    )
      throw new Error("invalid-reflection-snapshot")
  }
  function bounded(snapshots: ConversationSnapshot[]) {
    if (
      snapshots.length > conversations ||
      snapshots.reduce((total, snapshot) => total + Buffer.byteLength(snapshot.text, "utf8"), 0) >
        bytes
    )
      throw new Error("reflection-limit")
  }
  function decode(raw: string): State {
    try {
      const state: State = JSON.parse(raw)
      if (
        !state ||
        !Array.isArray(state.pending) ||
        !state.cursors ||
        typeof state.cursors !== "object" ||
        Array.isArray(state.cursors)
      )
        throw new Error("invalid-reflection-state")
      for (const [sessionID, hash] of Object.entries(state.cursors))
        if (!sessionID.trim() || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
          throw new Error("invalid-reflection-state")
      const keys = Object.keys(state.cursors)
      const order = state.cursorOrder ?? keys
      if (
        keys.length > cursors ||
        !Array.isArray(order) ||
        order.length !== keys.length ||
        new Set(order).size !== order.length ||
        order.some((key) => typeof key !== "string" || !Object.hasOwn(state.cursors, key))
      )
        throw new Error("invalid-reflection-state")
      state.cursorOrder = order
      // Dream bookkeeping is optional (rows written before the trigger existed
      // lack it) but any present value must be well formed: a timestamp that is
      // not a non-negative safe integer, or a flag that is not a boolean, would
      // otherwise steer the trigger from garbage.
      if (
        (state.activityAt !== undefined &&
          (!Number.isSafeInteger(state.activityAt) || state.activityAt < 0)) ||
        (state.dreamAt !== undefined &&
          (!Number.isSafeInteger(state.dreamAt) || state.dreamAt < 0)) ||
        (state.dreamDue !== undefined && typeof state.dreamDue !== "boolean")
      )
        throw new Error("invalid-dream-field")
      const snapshots = (items: ConversationSnapshot[]) => {
        const identities = new Set<string>()
        for (const snapshot of items) {
          validate(snapshot)
          if (identities.has(snapshot.sessionID)) throw new Error("invalid-reflection-state")
          identities.add(snapshot.sessionID)
        }
        bounded(items)
      }
      snapshots(state.pending)
      if (state.active !== null) {
        if (
          !state.active ||
          typeof state.active !== "object" ||
          typeof state.active.id !== "string" ||
          !state.active.id.trim() ||
          !Array.isArray(state.active.snapshots) ||
          state.active.snapshots.length === 0
        )
          throw new Error("invalid-reflection-state")
        snapshots(state.active.snapshots)
      }
      return state
    } catch {
      throw new Error("invalid-reflection-state")
    }
  }
  function update<T>(fn: (state: State) => T): T {
    mkdirSync(directory, { recursive: true })
    const db = new Database(file)
    try {
      db.run(
        "CREATE TABLE IF NOT EXISTS reflection_queue (scope TEXT PRIMARY KEY, state TEXT NOT NULL)",
      )
      return db
        .transaction(() => {
          const row = db.query("SELECT state FROM reflection_queue WHERE scope = ?").get(scope) as {
            state: string
          } | null
          const state: State = row ? decode(row.state) : { active: null, pending: [], cursors: {} }
          const result = fn(state)
          db.query(
            "INSERT INTO reflection_queue(scope, state) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET state=excluded.state",
          ).run(scope, JSON.stringify(state))
          return structuredClone(result)
        })
        .immediate()
    } finally {
      db.close()
    }
  }
  function finish(state: State, id: string, failed: boolean) {
    if (!state.active || state.active.id !== id) throw new Error("stale-reservation")
    for (const snapshot of state.active.snapshots) {
      if (failed) {
        if (!state.pending.some((item) => item.sessionID === snapshot.sessionID))
          state.pending.push(snapshot)
      } else {
        state.cursorOrder = (state.cursorOrder ?? Object.keys(state.cursors)).filter(
          (sessionID) => sessionID !== snapshot.sessionID,
        )
        state.cursorOrder.push(snapshot.sessionID)
        Object.defineProperty(state.cursors, snapshot.sessionID, {
          value: digest(snapshot.text),
          enumerable: true,
          configurable: true,
          writable: true,
        })
        while (state.cursorOrder.length > cursors) {
          const oldest = state.cursorOrder.shift()
          if (oldest !== undefined) delete state.cursors[oldest]
        }
      }
    }
    state.active = null
  }
  return {
    enqueue: (snapshot) =>
      update((state) => {
        validate(snapshot)
        const now = Date.now()
        if (snapshot.trigger === "dream") {
          // Checked before any mutation: a refusal must leave the owed flag and
          // the activity clock exactly as they were.
          const verdict = dreamVerdict(dreamConfig, state, now)
          if (!verdict.due) throw new Error(`dream-${verdict.reason}`)
        }
        // Idle is measured against the PREVIOUS activity timestamp: the
        // observation that returns to an idle session is itself activity, so
        // the gap has to be read before this call moves the clock. A deduplicated
        // enqueue still reaches here — idle is about time, not new text.
        if (dreamIdleDue(dreamConfig, state.activityAt, now)) state.dreamDue = true
        state.activityAt = now
        if (snapshot.trigger === "dream") {
          // The dream consumes the armed gap. Cadence starts here, whether or
          // not the snapshot below deduplicates against an already-settled
          // cursor: the reflection opportunity was addressed either way.
          state.dreamAt = now
          state.dreamDue = false
        }
        if (
          Object.hasOwn(state.cursors, snapshot.sessionID) &&
          state.cursors[snapshot.sessionID] === digest(snapshot.text)
        )
          return false
        const existing = state.pending.find((item) => item.sessionID === snapshot.sessionID)
        const next = { ...snapshot }
        if (existing && priority[existing.trigger] > priority[next.trigger])
          next.trigger = existing.trigger
        const pending = state.pending.filter((item) => item.sessionID !== snapshot.sessionID)
        pending.push(next)
        bounded(pending)
        // Account for active data too: a failed run can safely return to the queue.
        const retryable = [...pending]
        for (const item of state.active?.snapshots ?? [])
          if (!retryable.some((snapshot) => snapshot.sessionID === item.sessionID))
            retryable.push(item)
        bounded(retryable)
        state.pending = pending
        return true
      }),
    reserve: () =>
      update((state) => {
        if (state.active || state.pending.length === 0) return null
        state.active = {
          id: randomUUID(),
          snapshots: state.pending.sort((a, b) => priority[b.trigger] - priority[a.trigger]),
        }
        state.pending = []
        return state.active
      }),
    settle: (id, outcome) =>
      update((state) => {
        if (!["merged", "no_changes", "failed"].includes(outcome))
          throw new Error("invalid-reflection-outcome")
        finish(state, id, outcome === "failed")
      }),
    recover: (id) => update((state) => finish(state, id, true)),
    inspect: () => {
      if (!existsSync(file)) return { active: null, pending: [] }
      const db = new Database(file, { readonly: true })
      try {
        const row = db.query("SELECT state FROM reflection_queue WHERE scope = ?").get(scope) as {
          state: string
        } | null
        if (!row) return { active: null, pending: [] }
        const state = decode(row.state)
        return structuredClone({ active: state.active, pending: state.pending })
      } finally {
        db.close()
      }
    },
    dreamState: () => {
      // Read-only and non-creating, exactly like inspect: observing the dream
      // clock must never materialize storage for a session that has none.
      if (!existsSync(file)) return { activityAt: null, dreamAt: null, dreamDue: false }
      const db = new Database(file, { readonly: true })
      try {
        const row = db.query("SELECT state FROM reflection_queue WHERE scope = ?").get(scope) as {
          state: string
        } | null
        if (!row) return { activityAt: null, dreamAt: null, dreamDue: false }
        const state = decode(row.state)
        return structuredClone({
          activityAt: state.activityAt ?? null,
          dreamAt: state.dreamAt ?? null,
          dreamDue: state.dreamDue === true,
        })
      } finally {
        db.close()
      }
    },
  }
}

import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { type DreamConfig, dreamIdleDue, dreamVerdict, validateDreamConfig } from "./dream"
