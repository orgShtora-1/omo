import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { DEEP_INI_COMMAND, mountDeepIni } from "../../src/deepini/commands"

interface FakeCommandDefinition {
  name: string
  description?: string
  execute: (input: {
    sessionID: string
    prompt: { text?: string; files?: string[]; agents?: string[]; skills?: string[] }
    delivery: string
  }) => Promise<void>
}

interface PromptCall {
  sessionID: string
  text: string
  delivery: string
  files?: string[]
  agents?: string[]
  skills?: string[]
}

const PROJECT = "/repo/project"

function harness() {
  let definitions: FakeCommandDefinition[] = []
  const prompts: PromptCall[] = []
  let disposed = 0
  const ctx = {
    location: {
      directory: PROJECT,
      project: { id: "p", directory: PROJECT, canonical: PROJECT },
    },
    command: {
      transform: async (
        callback: (editor: { add: (d: FakeCommandDefinition) => void }) => void,
      ) => {
        callback({ add: (d: FakeCommandDefinition) => definitions.push(d) })
        return {
          dispose: async () => {
            definitions = []
            disposed++
          },
        }
      },
    },
    session: {
      prompt: async (input: PromptCall) => {
        prompts.push(input)
        return { data: {} }
      },
    },
  } as unknown as Plugin.Context
  return {
    ctx,
    prompts,
    get disposed() {
      return disposed
    },
    get registered() {
      return definitions
    },
  }
}

function require(h: ReturnType<typeof harness>) {
  const head = h.registered[0]
  if (!head) throw new Error("deep-ini was not registered")
  return head
}

test("registers exactly one command named deep-ini with a self-describing description", async () => {
  const h = harness()
  await mountDeepIni(h.ctx)
  expect(h.registered.map((d) => d.name)).toEqual([DEEP_INI_COMMAND])
  expect(require(h).description).toContain("--create-new")
  expect(require(h).description).toContain("--max-depth")
})

test("execute prompts the invoking session with the rendered body", async () => {
  const h = harness()
  await mountDeepIni(h.ctx)
  await require(h).execute({
    sessionID: "ses_1",
    prompt: { text: "--max-depth=2 --root=/proj focus on src" },
    delivery: "steer",
  })
  expect(h.prompts).toHaveLength(1)
  const sent = h.prompts[0]
  if (!sent) throw new Error("expected a prompt")
  expect(sent.sessionID).toBe("ses_1")
  expect(sent.delivery).toBe("steer")
  expect(sent.text).not.toContain("${")
  expect(sent.text).toContain("/proj")
  expect(sent.text).toContain("focus on src")
})

test("no arguments still produces a complete prompt, defaulting to the project root", async () => {
  const h = harness()
  await mountDeepIni(h.ctx)
  await require(h).execute({ sessionID: "ses_2", prompt: {}, delivery: "steer" })
  const sent = h.prompts[0]
  if (!sent) throw new Error("expected a prompt")
  expect(sent.text).not.toContain("${")
  expect(sent.text).toContain(PROJECT)
  expect(sent.text).toContain("update")
  expect(sent.text).not.toContain("## User focus")
})

test("the TUI attachments files, agents and skills survive the rewrite", async () => {
  const h = harness()
  await mountDeepIni(h.ctx)
  await require(h).execute({
    sessionID: "ses_3",
    prompt: {
      text: "--dry-run",
      files: ["a.ts"],
      agents: ["explore"],
      skills: ["ast-grep"],
    },
    delivery: "steer",
  })
  const sent = h.prompts[0]
  if (!sent) throw new Error("expected a prompt")
  expect(sent.files).toEqual(["a.ts"])
  expect(sent.agents).toEqual(["explore"])
  expect(sent.skills).toEqual(["ast-grep"])
})

test("an invalid flag rejects before any prompt reaches the session", async () => {
  const h = harness()
  await mountDeepIni(h.ctx)
  await expect(
    require(h).execute({
      sessionID: "ses_4",
      prompt: { text: "--max-depth=99" },
      delivery: "steer",
    }),
  ).rejects.toThrow("--max-depth")
  expect(h.prompts).toHaveLength(0)
})

test("unload removes the registration and is idempotent", async () => {
  const h = harness()
  const dispose = await mountDeepIni(h.ctx)
  expect(h.registered).toHaveLength(1)
  await dispose()
  expect(h.registered).toHaveLength(0)
  expect(h.disposed).toBe(1)
  await dispose()
  expect(h.disposed).toBe(1)
})
