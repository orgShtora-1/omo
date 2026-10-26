import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { openGoalStore } from "../../src/goal/store"
import { mountGoalContinuation } from "../../src/goal/tools"
import { rmRetry } from "../unit/test-utils"

test(
  "unload aborts the active goal prompt request and pauses its reservation",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "omo-goal-unload-"))
    const store = openGoalStore(dir)
    store.set("s", "Finish the owned goal")
    let signal: AbortSignal | undefined
    let release: () => void = () => {}
    let started: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const ctx = {
      location: { directory: dir, project: { id: "p", canonical: dir } },
      session: {
        async get() {
          return { id: "s", projectID: "p", location: { directory: dir } }
        },
        async prompt(_input: unknown, options?: { signal?: AbortSignal }) {
          signal = options?.signal
          started()
          await pending
          if (signal?.aborted) throw new Error("request aborted")
          return {}
        },
      },
      event: {
        subscribe() {
          return (async function* () {
            yield { type: "session.idle", data: { sessionID: "s" } }
          })()
        },
      },
    } as unknown as Plugin.Context
    const dispose = await mountGoalContinuation(ctx, store)
    let stopping: Promise<void> | undefined
    try {
      await ready
      expect(store.get("s")?.continuationPending).toBe(true)
      stopping = dispose()
      expect(signal?.aborted).toBe(true)
      release()
      await stopping
      expect(store.get("s")?.status).toBe("paused")
      expect(store.get("s")?.continuationPending).toBe(false)
    } finally {
      release()
      await (stopping ?? dispose())
      store.close()
      await rmRetry(dir)
    }
  },
  { timeout: 30000 },
)
