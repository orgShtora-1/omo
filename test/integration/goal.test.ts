import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { parseOptions } from "../../src/config/schema"
import { mountGoal } from "../../src/goal/tools"

type ToolRecord = {
  name: string
  description: string
  options: { namespace?: string; permission?: string }
  input: Record<string, unknown>
  output: unknown
  execute(input: Record<string, unknown>, context: unknown): Promise<unknown> | unknown
}

function fixture(canonical: string) {
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
      subscribe: (_input: unknown) => {
        async function* empty(): AsyncGenerator<never> {
          // No scripted events: the continuation loop stays parked.
        }
        return empty()
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
        await editor(target)
        return { dispose() {} }
      },
    },
  }
  return { ctx: ctx as unknown as Plugin.Context, added }
}

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-it-"))
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

test("goal_enabled defaults to false in the config schema", () => {
  expect((parseOptions({ schemaVersion: 1 }) as { goal_enabled?: boolean }).goal_enabled).toBe(
    false,
  )
  expect(() => parseOptions({ schemaVersion: 1, goal_enabled: 1 })).toThrow()
})

test("mountGoal registers create, update and get tools only when enabled", async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const enabled = fixture(dir)
    const disposeEnabled = await mountGoal(enabled.ctx, dir, true)
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
    await disposeEnabled()

    const disabled = fixture(dir)
    const disposeDisabled = await mountGoal(disabled.ctx, dir, false)
    expect(disabled.added).toHaveLength(0)
    await disposeDisabled()
  } finally {
    await cleanup()
  }
})

test("create_goal, update_goal and get_goal round-trip through the tools", async () => {
  const { dir, cleanup } = await tempDir()
  const { ctx, added } = fixture(dir)
  const dispose = await mountGoal(ctx, dir, true)
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
