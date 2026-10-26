import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { goalDirectory, openGoalStore } from "../../src/goal/store"
import { createGoalCommandService } from "../../src/goal/tools"
import { mountTerminal } from "../../src/terminal/commands"
import { rmRetry } from "../unit/test-utils"

test.timeout = 30000

interface FakeCommandDefinition {
  name: string
  execute: (input: {
    sessionID: string
    prompt: { text: string }
    delivery: string
  }) => Promise<unknown>
}

function harness() {
  const definitions: FakeCommandDefinition[] = []
  const output: string[] = []
  const ctx = {
    command: {
      transform: async (
        callback: (editor: { add: (definition: FakeCommandDefinition) => void }) => void,
      ) => {
        callback({ add: (definition) => definitions.push(definition) })
        return { dispose: async () => {} }
      },
    },
    session: {
      synthetic: async (input: { text: string }) => {
        output.push(input.text)
      },
    },
  } as unknown as Plugin.Context
  return { ctx, definitions, output }
}

async function run(definitions: FakeCommandDefinition[], name: string, text: string) {
  const definition = definitions.find((item) => item.name === name)
  if (!definition) throw new Error(`command ${name} was not registered`)
  await definition.execute({ sessionID: "ses_goal", prompt: { text }, delivery: "queue" })
}

const baseService = () => ({
  plan: async () => "created",
  status: async () => "running",
  resume: async () => "resumed",
  cancel: async () => "cancelled",
  compact: async () => "compacted",
  doctor: async () => "healthy",
})

test("omo-goal drives the session goal through show/set/pause/resume/complete/clear", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-cmd-"))
  const store = openGoalStore(goalDirectory(dir))
  const { ctx, definitions, output } = harness()
  const cleanup = await mountTerminal(
    ctx,
    { ...baseService(), goal: createGoalCommandService(dir, store) },
    { enabled: true },
  )
  try {
    expect(definitions.map((item) => item.name)).toContain("omo-goal")
    await run(definitions, "omo-goal", "")
    expect(output.at(-1)).toContain('"goal": null')
    await run(definitions, "omo-goal", "set Ship parity gate")
    expect(output.at(-1)).toContain("Ship parity gate")
    await run(definitions, "omo-goal", "SHOW")
    expect(output.at(-1)).toContain("Ship parity gate")
    await run(definitions, "omo-goal", "pause")
    expect(output.at(-1)).toContain('"paused"')
    await run(definitions, "omo-goal", "resume")
    expect(output.at(-1)).toContain('"active"')
    await run(definitions, "omo-goal", "complete")
    expect(output.at(-1)).toContain('"complete"')
    await run(definitions, "omo-goal", "set   ")
    expect(output.at(-1)).toContain("Error: objective must be a non-empty string")
    await run(definitions, "omo-goal", "frobnicate")
    expect(output.at(-1)).toContain("Usage: omo-goal")
    await run(definitions, "omo-goal", "clear")
    expect(output.at(-1)).toContain('"cleared": true')
    await run(definitions, "omo-goal", "")
    expect(output.at(-1)).toContain('"goal": null')
  } finally {
    await cleanup()
    store.close()
    await rmRetry(dir)
  }
})

test("omo-goal is omitted when the service has no goal handler", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-goal-absent-"))
  const { ctx, definitions } = harness()
  const cleanup = await mountTerminal(ctx, baseService(), { enabled: true })
  try {
    expect(definitions.map((item) => item.name)).not.toContain("omo-goal")
  } finally {
    await cleanup()
    await rmRetry(dir)
  }
})
