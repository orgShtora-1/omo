import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { type RuntimeServices, registerPlanTools } from "../../src/plans/tools"

interface StatusRun {
  model: undefined
  depth: undefined
  skills: string[]
  elapsedMs: null
}

interface StatusSnapshot {
  runs: StatusRun[]
  plans: never[]
}

interface StatusOutput {
  content: string
  output: { runs: Array<Record<string, unknown>> }
}

interface FakePlanTool {
  name: string
  execute: (
    input: Record<string, unknown>,
    context: { sessionID: string; signal: AbortSignal },
  ) => Promise<StatusOutput>
}

interface FakeToolNamespace {
  namespace: (name: string) => void
  get: (name: string) => undefined
  add: (tool: FakePlanTool) => void
}

function first<T>(items: readonly T[], what: string): T {
  const item = items[0]
  if (item === undefined) {
    throw new Error(`missing expected ${what}`)
  }
  return item
}

test("status structured output matches its JSON content when optional fields are absent", async () => {
  const tools = new Map<string, FakePlanTool>()
  const ctx = {
    tool: {
      transform: async (apply: (namespace: FakeToolNamespace) => void) =>
        apply({
          namespace: () => {},
          get: () => undefined,
          add: (tool: FakePlanTool) => tools.set(tool.name, tool),
        }),
    },
  }
  const status: StatusSnapshot = {
    runs: [{ model: undefined, depth: undefined, skills: [], elapsedMs: null }],
    plans: [],
  }
  await registerPlanTools(
    ctx as unknown as Plugin.Context,
    {
      status: async () => status,
    } as unknown as RuntimeServices,
  )
  const statusTool = tools.get("status")
  if (!statusTool) {
    throw new Error("status tool was not registered")
  }
  const result = await statusTool.execute(
    {},
    { sessionID: "parent", signal: new AbortController().signal },
  )
  expect(result.output).toStrictEqual(JSON.parse(result.content))
  expect(Object.hasOwn(first(result.output.runs, "status run"), "model")).toBe(false)
  expect(first(status.runs, "status fixture run")).toHaveProperty("model")
})
