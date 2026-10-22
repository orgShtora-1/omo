import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { assembleContext } from "../../src/context/assembly"
import { mountContext } from "../../src/context/compaction"
import type { Plan, PlanRepository, Scope } from "../../src/contracts"

function first<T>(items: readonly T[], what: string): T {
  const item = items[0]
  if (item === undefined) throw new Error(`missing ${what}`)
  return item
}

interface ContextHookSystemPart {
  type: string
  text: string
}

interface ContextHookInput {
  sessionID: string
  system: ContextHookSystemPart[]
  result?: { summary: string }
}

type ContextHook = (input: ContextHookInput) => Promise<void>

function named(hooks: Map<string, ContextHook>, name: string): ContextHook {
  const hook = hooks.get(name)
  if (!hook) throw new Error(`missing ${name} hook`)
  return hook
}

import { createPlan } from "../../src/plans/model"

test("recovery context retains the next step and artifact references without duplicating them", () => {
  const plan = createPlan({
    id: "plan",
    projectID: "project",
    parentSessionID: "parent",
    at: 0,
    steps: [{ id: "next", objective: "Verify the shipped package", dependencies: [] }],
  })
  first(plan.steps, "recovery step").evidence = [
    { id: "one", description: "build", artifact: "dist/index.js" },
    { id: "two", description: "types", artifact: "dist/index.js" },
  ]
  const packet = assembleContext(plan, "next", { maxChars: 1000, result: "x".repeat(5000) })
  expect(packet.text.length).toBeLessThanOrEqual(1000)
  expect(packet.text).toContain("Verify the shipped package")
  expect(packet.artifacts).toEqual(["dist/index.js"])
  expect(packet.text.match(/dist\/index.js/g)?.length).toBe(1)
  expect(packet.truncated).toBe(true)
  expect(plan.revision).toBe(0)
})

test("mandatory recovery context never silently loses its objective", () => {
  const plan = createPlan({
    id: "plan",
    projectID: "project",
    parentSessionID: "parent",
    at: 0,
    steps: [{ id: "next", objective: "x".repeat(200), dependencies: [] }],
  })
  expect(() => assembleContext(plan, "next", { maxChars: 100 })).toThrow("context-too-large")
})

test("host generation rehydrates durable next steps after compaction and disposes its listener once", async () => {
  const plan = createPlan({
    id: "plan",
    projectID: "project",
    parentSessionID: "parent",
    at: 0,
    steps: [{ id: "next", objective: "Inspect artifact", dependencies: [] }],
  })
  const hooks = new Map<string, ContextHook>()
  let disposed = 0
  const session = {
    hook: async (_name: string, handler: ContextHook) => {
      hooks.set(_name, handler)
      return {
        dispose: async () => {
          disposed++
        },
      }
    },
  }
  const repository = { list: async (): Promise<readonly Plan[]> => [plan] }
  const cleanup = await mountContext(
    { session } as unknown as Plugin.Context,
    repository as unknown as PlanRepository,
    async (id: string): Promise<Scope> => {
      if (id !== "parent") throw new Error("foreign-project")
      return { projectID: "project", locationID: "location", parentSessionID: "parent" }
    },
  )
  expect([...hooks.keys()].sort()).toEqual(["compaction", "context"])
  const contextHook = named(hooks, "context")
  const compactionHook = named(hooks, "compaction")
  const input = { sessionID: "parent", system: [{ type: "text", text: "Host summary" }] }
  await contextHook(input)
  await contextHook(input)
  expect(input.system).toHaveLength(2)
  expect(input.system[1]?.text).toContain("Inspect artifact")
  input.system = [{ type: "text", text: "Compacted history" }]
  await contextHook(input)
  expect(input.system[1]?.text).toContain("Inspect artifact")
  // Native /compact path: durable recovery refs are injected into the summary input.
  const compactInput = { sessionID: "parent", system: [{ type: "text", text: "Summarize me" }] }
  await compactionHook(compactInput)
  expect(compactInput.system).toHaveLength(2)
  expect(compactInput.system[1]?.text).toContain("Inspect artifact")
  // A compaction result owned by another plugin (or the host) is never overridden.
  const owned = { sessionID: "parent", system: [], result: { summary: "previous summary" } }
  await compactionHook(owned)
  expect(owned.result).toEqual({ summary: "previous summary" })
  expect(owned.system).toHaveLength(0)
  // Foreign sessions compact without OmO refs rather than failing the host flow.
  const foreign = { sessionID: "elsewhere", system: [{ type: "text", text: "Summarize me" }] }
  await compactionHook(foreign)
  expect(foreign.system).toHaveLength(1)
  await cleanup()
  await cleanup()
  expect(disposed).toBe(2)
})
