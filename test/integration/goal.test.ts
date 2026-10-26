import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { parseOptions } from "../../src/config/schema"
import { goalDirectory, openGoalStore } from "../../src/goal/store"
import { mountGoal } from "../../src/goal/tools"
import { rmRetry } from "../unit/test-utils"

type ToolRecord = {
  name: string
  description: string
  options: { namespace?: string; permission?: string }
  input: Record<string, unknown>
  output: unknown
  execute(input: Record<string, unknown>, context: unknown): Promise<unknown> | unknown
}

function fixture(canonical: string, store: ReturnType<typeof openGoalStore>) {
  const added: ToolRecord[] = []
  const ctx = {
    location: {
      directory: join(canonical, "session"),
      project: { id: "proj_test", canonical },
    },
    session: {
      async prompt() {
        return {}
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            await new Promise<void>((resolve) => {
              const onAbort = () => {
                signal.removeEventListener("abort", onAbort)
                resolve()
              }
              signal.addEventListener("abort", onAbort, { once: true })
            })
          }
        },
      }),
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
  return { ctx: ctx as unknown as Plugin.Context, added, store }
}

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-it-"))
  const store = openGoalStore(goalDirectory(dir))
  return {
    dir,
    store,
    cleanup: async () => {
      store.close()
      await rmRetry(dir)
    },
  }
}

test("goal_enabled defaults to false in the config schema", () => {
  expect((parseOptions({ schemaVersion: 1 }) as { goal_enabled?: boolean }).goal_enabled).toBe(
    false,
  )
  expect(() => parseOptions({ schemaVersion: 1, goal_enabled: 1 })).toThrow()
})

test("mountGoal registers create, update and get tools only when enabled", async () => {
  const { dir, cleanup, store } = await tempDir()
  try {
    const enabled = fixture(dir, store)
    console.log("About to call mountGoal (enabled)")
    const disposeEnabled = await mountGoal(enabled.ctx, dir, true, undefined, enabled.store)
    console.log("mountGoal (enabled) returned")
    expect(enabled.added.map((tool) => tool.name).sort()).toEqual([
      "create_goal",
      "get_goal",
      "update_goal",
    ])
    const createTool = enabled.added.find((tool) => tool.name === "create_goal")
    const updateTool = enabled.added.find((tool) => tool.name === "update_goal")
    const getTool = enabled.added.find((tool) => tool.name === "get_goal")
    expect(createTool?.options).toEqual({ namespace: "omo", permission: "edit" })
    expect(updateTool?.options).toEqual({ namespace: "omo", permission: "edit" })
    expect(getTool?.options).toEqual({ namespace: "omo", permission: "read" })
    console.log("About to call disposeEnabled")
    await disposeEnabled()
    console.log("disposeEnabled returned")

    const disabled = fixture(dir, store)
    console.log("About to call mountGoal (disabled)")
    const disposeDisabled = await mountGoal(disabled.ctx, dir, false)
    console.log("mountGoal (disabled) returned")
    expect(disabled.added).toHaveLength(0)
    console.log("About to call disposeDisabled")
    await disposeDisabled()
    console.log("disposeDisabled returned")
  } finally {
    console.log("About to call cleanup")
    await cleanup()
    console.log("cleanup returned")
  }
})

test("create_goal, update_goal and get_goal round-trip through the tools", async () => {
  const { dir, cleanup, store } = await tempDir()
  const { ctx, added } = fixture(dir, store)
  const dispose = await mountGoal(ctx, dir, true, undefined, store)
  try {
    const createTool = added.find((tool) => tool.name === "create_goal")
    const updateTool = added.find((tool) => tool.name === "update_goal")
    const getTool = added.find((tool) => tool.name === "get_goal")
    if (!createTool || !updateTool || !getTool) {
      throw new Error("expected create_goal, update_goal and get_goal tools")
    }
    const session = { sessionID: "ses_it" }

    const created = (await createTool.execute({ objective: "Ship parity gate" }, session)) as {
      output: string
    }
    expect(created.output).toContain("Ship parity gate")
    expect(created.output).toContain('"active"')

    const fetched = (await getTool.execute({}, session)) as { output: string }
    expect(fetched.output).toContain("Ship parity gate")

    const paused = (await updateTool.execute({ status: "paused" }, session)) as { output: string }
    expect(paused.output).toContain('"paused"')

    const completed = (await updateTool.execute({ status: "complete" }, session)) as {
      output: string
    }
    expect(completed.output).toContain('"complete"')

    const changed = (await updateTool.execute({ objective: "New objective" }, session)) as {
      output: string
    }
    expect(changed.output).toContain("New objective")
    expect(changed.output).toContain('"active"')

    await expect(createTool.execute({ objective: "   " }, session)).rejects.toThrow("non-empty")

    const isolated = (await getTool.execute({ session_id: "ses_other" }, session)) as {
      output: string
    }
    expect(isolated.output).toContain("foreign-session access refused")

    const targeted = (await createTool.execute(
      { objective: "Other session goal", session_id: "ses_other" },
      session,
    )) as { output: string }
    expect(targeted.output).toContain("foreign-session access refused")
  } finally {
    await dispose()
    await cleanup()
  }
})
