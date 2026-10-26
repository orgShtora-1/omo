import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { mountGoal } from "../../src/goal/tools"
import { rmRetry } from "../unit/test-utils"

test.timeout = 30000

type ToolRecord = {
  name: string
  description: string
  options: { namespace?: string; permission?: string }
  input: Record<string, unknown>
  output: unknown
  execute(input: Record<string, unknown>, context: unknown): Promise<unknown> | unknown
}

async function waitFor(label: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function liveFixture(canonical: string) {
  const added: ToolRecord[] = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  const push = (event: unknown) => {
    queue.push(event)
    if (wake) {
      wake()
      wake = null
    }
  }
  let subscribed = 0
  const ctx = {
    location: {
      directory: join(canonical, "session"),
      project: { id: "proj_test", canonical },
    },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        return {
          id: sessionID,
          projectID: "proj_test",
          location: { directory: join(canonical, "session") },
        }
      },
      async prompt(input: { sessionID: string; text: string }) {
        prompts.push(input)
        return {}
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        subscribed++
        return (async function* () {
          while (!signal.aborted) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                const onAbort = () => {
                  signal.removeEventListener("abort", onAbort)
                  resolve()
                }
                signal.addEventListener("abort", onAbort, { once: true })
                wake = () => {
                  signal.removeEventListener("abort", onAbort)
                  resolve()
                }
              })
            }
            yield queue.shift()
          }
        })()
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
        editor(target)
        return { dispose() {} }
      },
    },
  }
  return {
    ctx: ctx as unknown as Plugin.Context,
    added,
    prompts,
    push,
    wasSubscribed: () => subscribed,
  }
}

test("mountGoal continues an idle session toward its active goal and accrues usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-cont-it-"))
  const { ctx, added, prompts, push } = liveFixture(dir)
  const dispose = await mountGoal(ctx, dir, true)
  try {
    const createTool = added.find((tool) => tool.name === "create_goal")
    const getTool = added.find((tool) => tool.name === "get_goal")
    if (!createTool || !getTool) throw new Error("expected goal tools")
    const session = { sessionID: "ses_live" }
    await createTool.execute({ objective: "Ship parity gate" }, session)

    push({ type: "session.idle", data: { sessionID: "ses_live" } })
    await waitFor("continuation prompt", () => prompts.length > 0)
    expect(prompts[0]?.sessionID).toBe("ses_live")
    expect(prompts[0]?.text).toContain("Ship parity gate")

    // The host republishes cumulative totals, so the first report only establishes
    // the baseline and the second report's increase is what gets accrued.
    push({
      type: "session.usage.updated",
      data: {
        sessionID: "ses_live",
        cost: 0.02,
        tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 0, write: 0 } },
      },
    })
    push({
      type: "session.usage.updated",
      data: {
        sessionID: "ses_live",
        cost: 0.06,
        tokens: { input: 16, output: 8, reasoning: 2, cache: { read: 0, write: 0 } },
      },
    })
    const usageDeadline = Date.now() + 5000
    let fetched: { output: string } | undefined
    for (;;) {
      const current = (await getTool.execute({}, session)) as { output: string }
      const parsed = JSON.parse(current.output) as {
        goal: { tokensUsed: number } | null
      }
      if (parsed.goal?.tokensUsed === 10) {
        fetched = current
        break
      }
      if (Date.now() > usageDeadline) throw new Error("timed out waiting for usage accrual")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const goal = JSON.parse(fetched.output) as {
      goal: { tokensUsed: number; costUsed: number; continuations: number } | null
    }
    expect(goal.goal?.tokensUsed).toBe(10)
    expect(goal.goal?.costUsed).toBeCloseTo(0.04)
    expect(goal.goal?.continuations).toBe(1)
  } finally {
    console.log("About to call dispose")
    await dispose()
    console.log("dispose returned")
    console.log("About to call rmRetry")
    await rmRetry(dir)
    console.log("rmRetry returned")
  }
})

test("mountGoal never subscribes to events when disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-cont-off-"))
  const { ctx, added, prompts, push, wasSubscribed } = liveFixture(dir)
  const dispose = await mountGoal(ctx, dir, false)
  try {
    expect(added).toHaveLength(0)
    push({ type: "session.idle", data: { sessionID: "ses_live" } })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(prompts).toHaveLength(0)
    expect(wasSubscribed()).toBe(0)
  } finally {
    await dispose()
    await rmRetry(dir)
  }
})
