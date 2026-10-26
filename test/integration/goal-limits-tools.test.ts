import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { goalDirectory, openGoalStore, type UsageSnapshot } from "../../src/goal/store"
import { createGoalCommandService, mountGoal } from "../../src/goal/tools"
import { rmRetry } from "../unit/test-utils"

type ToolRecord = {
  name: string
  options: { namespace?: string; permission?: string }
  execute(input: Record<string, unknown>, context: unknown): Promise<{ output: string }>
}

async function fixture() {
  const canonical = await mkdtemp(join(tmpdir(), "omo-goal-limits-tools-"))
  const stateDir = await mkdtemp(join(tmpdir(), "omo-goal-limits-state-"))
  const added: ToolRecord[] = []
  const store = openGoalStore(goalDirectory(stateDir))
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
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            )
        },
      }),
    },
    tool: {
      async transform(callback: (editor: unknown) => unknown | Promise<unknown>) {
        callback({
          namespace() {},
          get() {
            return undefined
          },
          add(record: ToolRecord) {
            added.push(record)
          },
        })
        return { dispose() {} }
      },
    },
  } as unknown as Plugin.Context
  const dispose = await mountGoal(ctx, stateDir, true, undefined, store)
  const tool = (name: string) => {
    const found = added.find((item) => item.name === name)
    if (!found) throw new Error(`missing registered tool: ${name}`)
    return found
  }
  const self = { sessionID: "ses_owner" }
  const goal = async (name: string, input: Record<string, unknown>) => {
    const result = await tool(name).execute(input, self)
    return JSON.parse(result.output) as { goal: Record<string, unknown> | null }
  }
  return {
    ctx,
    canonical,
    stateDir,
    store,
    tool,
    goal,
    async cleanup() {
      await dispose()
      store.close()
      await rmRetry(canonical)
      await rmRetry(stateDir)
    },
  }
}

function snapshot(cost: number, tokens: number): UsageSnapshot {
  return {
    cost,
    tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

test(
  "create_goal stores a validated budget and get_goal reports the breach that pauses it",
  async () => {
    const f = await fixture()
    try {
      expect(
        (await f.goal("create_goal", { objective: "ship release", limits: { maxCost: 0.1 } })).goal,
      ).toMatchObject({ status: "active", limits: { maxCost: 0.1 } })
      expect(f.tool("create_goal").options).toEqual({ namespace: "omo", permission: "edit" })
      expect(f.tool("get_goal").options).toEqual({ namespace: "omo", permission: "read" })
      f.store.accrueSnapshot("ses_owner", snapshot(0.05, 10))
      f.store.accrueSnapshot("ses_owner", snapshot(0.16, 20))
      expect((await f.goal("get_goal", {})).goal).toMatchObject({
        status: "paused",
        limitExceeded: "cost",
      })
      // The model cannot re-arm itself past a user budget.
      await expect(
        f.tool("update_goal").execute({ status: "active" }, { sessionID: "ses_owner" }),
      ).rejects.toThrow("limit-exceeded: cost")
    } finally {
      await f.cleanup()
    }
  },
  { timeout: 30000 },
)

test.each([
  ["zero", { maxCost: 0 }],
  ["fractional tokens", { maxTokens: 1.5 }],
  ["unknown dimension", { maxDuration: 60 }],
  ["empty", {}],
  ["non-object", 5],
])(
  "create_goal refuses a %s budget without writing the goal",
  async (_name: string, limits: unknown) => {
    const f = await fixture()
    try {
      await expect(
        f
          .tool("create_goal")
          .execute({ objective: "ship release", limits }, { sessionID: "ses_owner" }),
      ).rejects.toThrow("invalid-limits")
      expect(f.store.get("ses_owner")).toBeNull()
      expect(
        await readFile(join(goalDirectory(f.stateDir), "ses_owner.json"), "utf8").catch(() => null),
      ).toBeNull()
    } finally {
      await f.cleanup()
    }
  },
  { timeout: 30000 },
)

test(
  "update_goal cannot raise the budget of a breached goal or resurrect a cancelled one",
  async () => {
    const f = await fixture()
    try {
      await f.goal("create_goal", {
        objective: "ship release",
        limits: { maxCost: 0.1, maxTokens: 50 },
      })
      f.store.accrueSnapshot("ses_owner", snapshot(0.05, 10))
      f.store.accrueSnapshot("ses_owner", snapshot(0.16, 80))
      expect((await f.goal("get_goal", {})).goal).toMatchObject({ limitExceeded: "cost" })
      // A breached goal stays breached: rewriting the objective with a bigger
      // budget must not silently re-arm it with a fresh continuation budget.
      await expect(
        f.tool("update_goal").execute(
          {
            objective: "ship release with a larger budget",
            limits: { maxCost: 10, maxTokens: 500 },
          },
          { sessionID: "ses_owner" },
        ),
      ).rejects.toThrow("limit-exceeded: cost")
      const breached = f.store.get("ses_owner")
      expect(breached).toMatchObject({
        status: "paused",
        limitExceeded: "cost",
        limits: { maxCost: 0.1, maxTokens: 50 },
      })
      // Lifetime counters survive the refused rewrite, so usage cannot be laundered.
      expect(breached?.costUsed).toBeCloseTo(0.11, 10)
      expect(breached?.tokensUsed).toBe(70)
      expect(breached?.continuations).toBe(0)
      await f.goal("update_goal", { status: "cancelled" })
      await expect(
        f.tool("update_goal").execute(
          { objective: "start over", status: "active" },
          {
            sessionID: "ses_owner",
          },
        ),
      ).rejects.toThrow("cancelled goal is terminal")
      await expect(
        f.tool("update_goal").execute({ objective: "start over" }, { sessionID: "ses_owner" }),
      ).rejects.toThrow("cancelled goal is terminal")
      expect((await f.goal("get_goal", {})).goal).toMatchObject({ status: "cancelled" })
    } finally {
      await f.cleanup()
    }
  },
  { timeout: 30000 },
)

test(
  "update_goal cancellation is terminal for every later status change",
  async () => {
    const f = await fixture()
    try {
      await f.goal("create_goal", { objective: "ship release" })
      expect((await f.goal("update_goal", { status: "cancelled" })).goal).toMatchObject({
        status: "cancelled",
      })
      for (const status of ["active", "paused", "complete"]) {
        await expect(
          f.tool("update_goal").execute({ status }, { sessionID: "ses_owner" }),
        ).rejects.toThrow("cancelled goal is terminal")
      }
      expect((await f.goal("get_goal", {})).goal).toMatchObject({ status: "cancelled" })
      // Cancelling again stays allowed so repeated cleanup cannot fail.
      expect((await f.goal("update_goal", { status: "cancelled" })).goal).toMatchObject({
        status: "cancelled",
      })
    } finally {
      await f.cleanup()
    }
  },
  { timeout: 30000 },
)

test(
  "update_goal recovery resolves an unresolved admission and rejects unknown dispositions",
  async () => {
    const f = await fixture()
    try {
      await f.goal("create_goal", { objective: "ship release" })
      f.store.noteContinuation("ses_owner")
      expect((await f.goal("get_goal", {})).goal).toMatchObject({ continuationPending: true })
      await expect(
        f.tool("update_goal").execute({ status: "active" }, { sessionID: "ses_owner" }),
      ).rejects.toThrow("unresolved-continuation")
      expect((await f.goal("update_goal", { recover: "abandon" })).goal).toMatchObject({
        status: "paused",
        continuationPending: false,
      })
      // Recovery resolves the admission and never re-arms the continuation budget,
      // so a breach refusal cannot be side-stepped through `recover`.
      f.store.noteContinuation("ses_owner")
      expect((await f.goal("update_goal", { recover: "retry" })).goal).toMatchObject({
        continuationPending: false,
        continuations: 1,
        status: "paused",
      })
      await expect(
        f.tool("update_goal").execute({ recover: "sideways" }, { sessionID: "ses_owner" }),
      ).rejects.toThrow("invalid-recovery-disposition")
      expect(f.store.get("ses_owner")?.continuations).toBe(1)
    } finally {
      await f.cleanup()
    }
  },
  { timeout: 30000 },
)

test(
  "budget, cancellation and recovery stay inside the native session",
  async () => {
    const f = await fixture()
    try {
      f.store.set("ses_victim", "victim objective", { maxCost: 1 })
      // Snapshot the victim's stored objective — used to verify the record is
      // unchanged after a foreign-session attempt.
      const victimSnapshot = f.store.get("ses_victim")?.objective ?? null
      for (const [name, input] of [
        [
          "create_goal",
          { objective: "attacker objective", limits: { maxCost: 9 }, session_id: "ses_victim" },
        ],
        ["update_goal", { status: "cancelled", session_id: "ses_victim" }],
        ["update_goal", { recover: "abandon", session_id: "ses_victim" }],
        ["update_goal", { limits: { maxTokens: 1 }, session_id: "ses_victim" }],
      ] as const) {
        const result = await f.tool(name).execute(input, { sessionID: "ses_caller" })
        expect(result.output).toMatch(/Error:.*foreign-session/)
      }
      expect(f.store.get("ses_victim")?.objective).toBe(victimSnapshot as string | undefined)
      expect(f.store.get("ses_caller")).toBeNull()
      const anonymous = await f.tool("create_goal").execute({ limits: { maxCost: 1 } }, {})
      expect(anonymous.output).toMatch(/Error:.*session.*identity/)
      expect(f.store.get("ses_caller")).toBeNull()
    } finally {
      await f.cleanup()
    }
  },
  { timeout: 30000 },
)

test("omo-goal exposes cancel and recover next to the existing verbs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-limits-cmd-"))
  const store = openGoalStore(goalDirectory(dir))
  const service = createGoalCommandService(dir, store)
  try {
    // Cancelling a session without a goal is a no-op, not an error.
    expect(await service({ sessionID: "ses_owner", text: "cancel" })).toMatch(/"goal": null/)
    await service({ sessionID: "ses_owner", text: "set ship release" })
    expect(await service({ sessionID: "ses_owner", text: "cancel" })).toMatch(
      /"status": "cancelled"/,
    )
    expect(await service({ sessionID: "ses_owner", text: "resume" })).toMatch(
      /Error: cancelled goal is terminal/,
    )
    store.clear("ses_owner")
    await service({ sessionID: "ses_owner", text: "set ship release" })
    store.noteContinuation("ses_owner")
    expect(await service({ sessionID: "ses_owner", text: "recover abandon" })).toMatch(
      /"status": "paused"/,
    )
    expect(await service({ sessionID: "ses_owner", text: "recover sideways" })).toMatch(
      /Error: invalid-recovery-disposition/,
    )
    // Unknown verbs still render usage, including the new ones.
    expect(await service({ sessionID: "ses_owner", text: "sideways" })).toMatch(
      /Usage: omo-goal \[show .*recover <retry\|abandon>/,
    )
  } finally {
    store.close()
    await rmRetry(dir)
  }
})
