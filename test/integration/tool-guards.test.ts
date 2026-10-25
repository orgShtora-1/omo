import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { computeLineHash } from "../../src/hashline/hash"
import { mountToolGuards } from "../../src/runtime/tool-guards"

type AfterHook = (input: unknown) => Promise<void> | void

function first<T>(items: readonly T[], what: string): T {
  const value = items[0]
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}

/** The truncation/JSON-hint hook is registered after mountEditRecovery,
 * so it sits at the end of the afterHooks array. */
function guardHook(hooks: readonly AfterHook[]): AfterHook {
  const value = hooks[hooks.length - 1]
  if (value === undefined) throw new Error("missing guard hook")
  return value
}

interface GuardsFixture {
  ctx: Plugin.Context
  afterHooks: AfterHook[]
  beforeHooks: Array<(input: unknown) => Promise<void> | void>
  updated: string[]
  readTool: FakeReadTool
}

interface FakeReadTool {
  execute: (input: unknown, context: unknown) => Promise<{ output?: unknown; content?: unknown }>
}

function fixture(): GuardsFixture {
  const afterHooks: AfterHook[] = []
  const beforeHooks: Array<(input: unknown) => Promise<void> | void> = []
  const registrations: Array<{ name: string }> = []
  const updated: string[] = []
  const readTool: FakeReadTool = {
    execute: async () => ({ output: "1: alpha\n2: beta" }),
  }
  const ctx = {
    tool: {
      hook: async (name: string, callback: (input: unknown) => Promise<void> | void) => {
        if (name === "execute.after") afterHooks.push(callback)
        if (name === "execute.before") beforeHooks.push(callback)
        const entry = { name }
        registrations.push(entry)
        return {
          dispose: async () => {
            const index = registrations.indexOf(entry)
            if (index >= 0) registrations.splice(index, 1)
            if (name === "execute.after") {
              const at = afterHooks.indexOf(callback)
              if (at >= 0) afterHooks.splice(at, 1)
            }
            if (name === "execute.before") {
              const at = beforeHooks.indexOf(callback)
              if (at >= 0) beforeHooks.splice(at, 1)
            }
          },
        }
      },
      transform: async (
        callback: (editor: {
          get: () => undefined
          update: (id: string, update: (tool: FakeReadTool) => void) => void
        }) => void,
      ) => {
        callback({
          get: () => undefined,
          update: (id: string, update: (tool: FakeReadTool) => void) => {
            updated.push(id)
            if (id === "read") update(readTool)
          },
        })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context
  return { ctx, afterHooks, beforeHooks, updated, readTool }
}

interface CompletedInput {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  id: string
  input: unknown
  status: "completed"
  result: { output?: unknown; content?: unknown }
}

interface ErrorInput {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  id: string
  input: unknown
  status: "error"
  error: { message: string }
}

function completed(result: { output?: unknown; content?: unknown }): CompletedInput {
  return {
    tool: "bash",
    sessionID: "ses_test",
    agent: "executor",
    messageID: "msg_test",
    id: "call_test",
    input: {},
    status: "completed",
    result,
  }
}

function failed(message: string): ErrorInput {
  return {
    tool: "bash",
    sessionID: "ses_test",
    agent: "executor",
    messageID: "msg_test",
    id: "call_test",
    input: {},
    status: "error",
    error: { message },
  }
}

test("tool guards truncate oversized output and content", async () => {
  const { ctx, afterHooks } = fixture()
  const dispose = await mountToolGuards(ctx)
  const after = guardHook(afterHooks)

  const big = "x".repeat(150_000)
  const completedInput = completed({ output: big, content: big })
  await after(completedInput)

  const output = completedInput.result.output
  const content = completedInput.result.content
  expect(typeof output).toBe("string")
  expect((output as string).length).toBeLessThan(big.length)
  expect(output as string).toContain("truncated by shtora.omo")
  expect(typeof content).toBe("string")
  expect((content as string).length).toBeLessThan(big.length)
  expect(content as string).toContain("truncated by shtora.omo")

  await dispose()
  expect(afterHooks).toHaveLength(0)
})

test("tool guards leave small results untouched", async () => {
  const { ctx, afterHooks } = fixture()
  await mountToolGuards(ctx)
  const after = guardHook(afterHooks)

  const completedInput = completed({ output: "short", content: [{ type: "text", text: "ok" }] })
  await after(completedInput)
  expect(completedInput.result.output).toBe("short")
  expect(completedInput.result.content).toEqual([{ type: "text", text: "ok" }])
})

test("tool guards append a JSON correction hint to json errors", async () => {
  const { ctx, afterHooks } = fixture()
  await mountToolGuards(ctx)
  const after = guardHook(afterHooks)

  const jsonError = failed("Unexpected token } in JSON at position 42")
  await after(jsonError)
  expect(jsonError.error.message).toContain("Unexpected token }")
  expect(jsonError.error.message).toContain("shtora.omo")

  const otherError = failed("permission denied")
  await after(otherError)
  expect(otherError.error.message).toBe("permission denied")
})

test("tool guards truncate long text parts inside content arrays", async () => {
  const { ctx, afterHooks } = fixture()
  await mountToolGuards(ctx)
  const after = guardHook(afterHooks)

  const big = "y".repeat(150_000)
  const completedInput = completed({ content: [{ type: "text", text: big }] })
  await after(completedInput)

  const content = completedInput.result.content
  expect(Array.isArray(content)).toBe(true)
  const part = Array.isArray(content) ? first(content, "content part") : undefined
  expect(
    part && typeof part === "object" ? (part as { text?: unknown }).text : undefined,
  ).toBeDefined()
  const text = (part as { text?: unknown }).text
  expect(typeof text).toBe("string")
  expect((text as string).length).toBeLessThan(big.length)
})
test("mountToolGuards wraps the native read execute with LINE#ID hashes when hashline is enabled", async () => {
  const { ctx, readTool, updated } = fixture()
  const dispose = await mountToolGuards(ctx, true)
  expect(updated).toContain("read")
  const result = await readTool.execute({}, {})
  expect(result.output).toBe(
    `1#${computeLineHash(1, "alpha")}|alpha\n2#${computeLineHash(2, "beta")}|beta`,
  )
  await dispose()
})

test("mountToolGuards leaves the native read execute alone when hashline is disabled", async () => {
  const { ctx, readTool, updated } = fixture()
  const dispose = await mountToolGuards(ctx)
  expect(updated).not.toContain("read")
  const result = await readTool.execute({}, {})
  expect(result.output).toBe("1: alpha\n2: beta")
  await dispose()
})

test.each(["string", "parts"])(
  "hashline tags V2 read content through wrapper and hook (%s)",
  async (shape) => {
    const { ctx, readTool, afterHooks } = fixture()
    const text = "1: alpha\n2: beta"
    const tagged = `1#${computeLineHash(1, "alpha")}|alpha\n2#${computeLineHash(2, "beta")}|beta`
    const content =
      shape === "string"
        ? text
        : [
            { type: "text", text },
            { type: "image", data: "unchanged" },
          ]
    const expected =
      shape === "string"
        ? tagged
        : [
            { type: "text", text: tagged },
            { type: "image", data: "unchanged" },
          ]
    readTool.execute = async () => ({ content })
    const dispose = await mountToolGuards(ctx, true)
    const result = await readTool.execute({}, {})
    expect(result.content).toEqual(expected)
    const after = guardHook(afterHooks)
    const input = completed({ content })
    input.tool = "read"
    await after(input)
    expect(input.result.content).toEqual(expected)
    await after(input)
    expect(input.result.content).toEqual(expected)
    const nonRead = completed({ content })
    await after(nonRead)
    expect(nonRead.result.content).toEqual(content)
    await dispose()
  },
)
