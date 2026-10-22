import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { type RuntimeServices, registerPlanTools, type TaskInput } from "../../src/plans/tools"

type Captured = {
  parentID: string
  input: TaskInput
  signal: AbortSignal
}

function fixture() {
  const tools = new Map<
    string,
    {
      name: string
      description: string
      options: Record<string, unknown>
      execute: (
        input: Record<string, unknown>,
        context: {
          sessionID: string
          signal: AbortSignal
          progress: (update: Record<string, unknown>) => Promise<void>
        },
      ) => Promise<unknown>
    }
  >()
  const delegated: Captured[] = []
  const ctx = {
    tool: {
      transform: async (
        apply: (namespace: {
          namespace: () => void
          get: (name: string) => unknown
          add: (tool: typeof tools extends Map<string, infer V> ? V : never) => void
        }) => void,
      ) =>
        apply({
          namespace: () => {},
          get: () => undefined,
          add: (tool) => tools.set(tool.name, tool),
        }),
    },
  }
  const runtime = {
    delegate: async (parentID: string, input: TaskInput, signal: AbortSignal) => {
      delegated.push({ parentID, input, signal })
      return {
        attemptID: "attempt-c1",
        sessionID: "ses_consult",
        state: "running",
      } as unknown as Awaited<ReturnType<RuntimeServices["delegate"]>>
    },
  } as unknown as RuntimeServices
  return { ctx: ctx as unknown as Plugin.Context, runtime, tools, delegated }
}

test("omo_consult registers with consult permission", async () => {
  const { ctx, runtime, tools } = fixture()
  await registerPlanTools(ctx, runtime)
  const consult = tools.get("consult")
  expect(consult).toBeDefined()
  expect(consult?.options.permission).toBe("consult")
})

test("omo_consult forwards the request to the runtime delegate", async () => {
  const { ctx, runtime, tools, delegated } = fixture()
  await registerPlanTools(ctx, runtime)
  const consult = tools.get("consult")
  if (!consult) throw new Error("consult tool missing")
  const signal = new AbortController().signal
  const progressReports: Record<string, unknown>[] = []
  const result = (await consult.execute(
    {
      taskID: "c1",
      prompt: "Find the auth module",
      route: { kind: "agent", id: "explore" },
      files: ["src/auth.ts"],
    },
    {
      sessionID: "parent",
      signal,
      progress: async (update) => {
        progressReports.push(update)
      },
    },
  )) as { metadata?: Record<string, unknown> }
  expect(delegated).toHaveLength(1)
  const capture = delegated[0]
  if (!capture) throw new Error("delegate was not captured")
  expect(capture).toMatchObject({
    parentID: "parent",
    input: {
      taskID: "c1",
      prompt: "Find the auth module",
      route: { kind: "agent", id: "explore" },
      files: ["src/auth.ts"],
      background: true,
    },
  })
  expect(capture.signal).toBe(signal)
  // The wrapper surfaces the child to the host TUI: one progress report on
  // admission plus metadata the TUI projects for child discovery.
  expect(progressReports).toEqual([{ sessionID: "ses_consult", status: "running" }])
  expect(result.metadata).toEqual({ sessionID: "ses_consult" })
})
