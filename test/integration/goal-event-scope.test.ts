import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { openGoalStore } from "../../src/goal/store"
import { mountGoalContinuation } from "../../src/goal/tools"
import { rmRetry } from "../unit/test-utils"

test.timeout = 30000

test.each(["project", "location", "missing", "owned"])(
  "goal events enforce %s session scope before usage or admission",
  async (failure) => {
    const dir = await mkdtemp(join(tmpdir(), "omo-goal-event-scope-"))
    const store = openGoalStore(dir)
    store.set("s", "Keep this goal untouched")
    // A healthy sibling in the same project and location is the positive control:
    // without it, `toBe(0)` for the failing session would also pass if the
    // subscriber never attached at all (reviewer finding T10).
    store.set("healthy", "control")
    let prompts = 0
    let finished: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      finished = resolve
    })
    const ctx = {
      location: { directory: dir, project: { id: "p", canonical: dir } },
      session: {
        async get({ sessionID }: { sessionID: string }) {
          if (sessionID === "healthy")
            return { id: "healthy", projectID: "p", location: { directory: dir } }
          if (failure === "missing") throw new Error("not found")
          return {
            id: "s",
            projectID: failure === "project" ? "foreign" : "p",
            location: { directory: failure === "location" ? join(dir, "other") : dir },
          }
        },
        async prompt() {
          prompts++
          return {}
        },
      },
      event: {
        subscribe() {
          return (async function* () {
            try {
              // Two cumulative reports: the first is only the baseline, the second adds 9
              // cache-read tokens. A foreign session must accrue nothing at all.
              for (const sessionID of ["healthy", "s"] as const) {
                yield {
                  type: "session.usage.updated",
                  data: {
                    sessionID,
                    cost: 1,
                    tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 100, write: 10 } },
                  },
                }
                yield {
                  type: "session.usage.updated",
                  data: {
                    sessionID,
                    cost: 1,
                    tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 109, write: 10 } },
                  },
                }
              }
              yield { type: "session.idle", data: { sessionID: "s" } }
            } finally {
              finished()
            }
          })()
        },
      },
    } as unknown as Plugin.Context
    const dispose = await mountGoalContinuation(ctx, store)
    try {
      await done
      // Positive control: the sibling always accrues, so a zero below proves
      // scoping refused the event rather than the subscriber being absent.
      expect(store.get("healthy")?.tokensUsed).toBe(9)
      expect(prompts).toBe(failure === "owned" ? 1 : 0)
      expect(store.get("s")?.tokensUsed).toBe(failure === "owned" ? 9 : 0)
      expect(store.get("s")?.continuations).toBe(failure === "owned" ? 1 : 0)
    } finally {
      await dispose()
      store.close()
      await rmRetry(dir)
    }
  },
)
