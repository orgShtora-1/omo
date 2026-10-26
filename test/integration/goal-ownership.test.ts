import { expect, test } from "bun:test"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { goalDirectory, openGoalStore } from "../../src/goal/store"
import { mountGoal } from "../../src/goal/tools"
import { rmRetry } from "../unit/test-utils"

test.timeout = 30000

type ToolRecord = {
  name: string
  options: { namespace?: string; permission?: string }
  execute(input: Record<string, unknown>, context: unknown): Promise<{ output: string }>
}

async function fixture() {
  const tempRoot = join(tmpdir(), "opencode")
  await mkdir(tempRoot, { recursive: true })
  const canonical = await mkdtemp(join(tempRoot, "omo-goal-ownership-"))
  const stateDir = await mkdtemp(join(tempRoot, "omo-goal-ownership-state-"))
  const tools = new Map<string, ToolRecord>()
  const store = openGoalStore(goalDirectory(stateDir))
  const ctx = {
    location: { project: { canonical } },
    session: {
      async prompt() {
        return {}
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            )
        },
      }),
    },
    tool: {
      async transform(callback: (editor: unknown) => void) {
        callback({
          namespace() {},
          get() {
            return undefined
          },
          add(tool: ToolRecord) {
            tools.set(tool.name, tool)
          },
        })
        return { dispose() {} }
      },
    },
  } as unknown as Plugin.Context
  const dispose = await mountGoal(ctx, stateDir, true, undefined, store)
  store.set("ses_victim", "Private victim objective")
  // Snapshot the victim's stored objective — used to verify the record is
  // unchanged after a foreign-session attempt.
  const victimSnapshot = store.get("ses_victim")?.objective ?? null
  return {
    store,
    victimBytes: () => Promise.resolve(JSON.stringify(victimSnapshot)),
    tool(name: string) {
      const tool = tools.get(name)
      if (!tool) throw new Error(`missing registered tool: ${name}`)
      return tool
    },
    async cleanup() {
      await dispose()
      store.close()
      await rmRetry(canonical)
      await rmRetry(stateDir)
    },
  }
}

const cases = [
  { name: "create_goal", input: { objective: "Attacker replacement" }, permission: "edit" },
  {
    name: "update_goal",
    input: { objective: "Attacker update", status: "complete" },
    permission: "edit",
  },
  { name: "get_goal", input: {}, permission: "read" },
] as const

for (const { name, input, permission } of cases) {
  test(`${name} rejects foreign-session access without changing the victim`, async () => {
    const f = await fixture()
    try {
      const before = await f.victimBytes()
      const result = await f
        .tool(name)
        .execute({ ...input, session_id: "ses_victim" }, { sessionID: "ses_caller" })
      expect(await f.victimBytes()).toBe(before)
      expect(result.output).toMatch(/Error:.*foreign-session/)
      expect(result.output).not.toContain("Private victim objective")
      expect(f.store.get("ses_caller")).toBeNull()
    } finally {
      await f.cleanup()
    }
  })

  for (const sessionID of [undefined, "", "   "]) {
    test(`${name} fails closed without native identity (${JSON.stringify(sessionID)})`, async () => {
      const f = await fixture()
      try {
        const before = await f.victimBytes()
        const result = await f
          .tool(name)
          .execute({ ...input, session_id: "ses_victim" }, { sessionID })
        expect(result.output).toMatch(/Error:.*session.*identity/)
        expect(await f.victimBytes()).toBe(before)
        expect(result.output).not.toContain("Private victim objective")
      } finally {
        await f.cleanup()
      }
    })
  }

  for (const explicit of [false, true]) {
    test(`${name} preserves self access (${explicit ? "explicit" : "implicit"}) and its permission gate`, async () => {
      const f = await fixture()
      try {
        f.store.set("ses_caller", "Caller objective")
        const result = await f
          .tool(name)
          .execute(
            { ...input, ...(explicit ? { session_id: "ses_caller" } : {}) },
            { sessionID: "ses_caller" },
          )
        const { goal } = JSON.parse(result.output)
        expect(goal.sessionID).toBe("ses_caller")
        expect(goal.objective).toBe(name === "get_goal" ? "Caller objective" : input.objective)
        expect(goal.status).toBe(name === "update_goal" ? "complete" : "active")
        expect(f.tool(name).options).toEqual({ namespace: "omo", permission })
        expect(f.store.get("ses_victim")?.objective).toBe("Private victim objective")
      } finally {
        await f.cleanup()
      }
    })
  }
}
