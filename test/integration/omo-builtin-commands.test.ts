import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { mountHandoff } from "../../src/handoff/commands"
import { mountRefactor } from "../../src/refactor/commands"

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
  const registration = {
    dispose: async () => {
      definitions = []
      disposed++
    },
  }
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
        return registration
      },
    },
    session: { prompt: async (input: PromptCall) => void prompts.push(input) },
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
    named(name: string) {
      const found = definitions.find((d) => d.name === name)
      if (!found) throw new Error(`${name} was not registered`)
      return found
    },
  }
}

test("both commands register with self-describing arguments", async () => {
  const h = harness()
  await mountRefactor(h.ctx)
  await mountHandoff(h.ctx)
  expect(h.registered.map((d) => d.name)).toEqual(["refactor", "handoff"])
  expect(h.named("refactor").description).toContain("--strategy=safe|aggressive")
  expect(h.named("handoff").description).toContain("--to=session|agent")
})

test("refactor prompts the invoking session with the target, scope and strategy resolved", async () => {
  const h = harness()
  await mountRefactor(h.ctx)
  await h.named("refactor").execute({
    sessionID: "ses_r",
    prompt: { text: "--scope=file --strategy=aggressive src/a.ts keep the signature" },
    delivery: "steer",
  })
  const sent = h.prompts[0]
  if (!sent) throw new Error("expected a prompt")
  expect(sent.sessionID).toBe("ses_r")
  expect(sent.delivery).toBe("steer")
  expect(sent.text).not.toContain("${")
  expect(sent.text).toContain("src/a.ts")
  expect(sent.text).toContain("keep the signature")
  expect(sent.text).toContain("## User focus (honor these)")
})

test("a bare refactor carries the unspecified-target sentinel instead of a guessed scope", async () => {
  const h = harness()
  await mountRefactor(h.ctx)
  await h.named("refactor").execute({ sessionID: "ses_r2", prompt: {}, delivery: "steer" })
  const sent = h.prompts[0]
  if (!sent) throw new Error("expected a prompt")
  expect(sent.text).toContain("UNSPECIFIED")
  expect(sent.text).not.toContain("${")
})

test("refactor rejects an invalid flag before any prompt reaches the session", async () => {
  const h = harness()
  await mountRefactor(h.ctx)
  await expect(
    h.named("refactor").execute({
      sessionID: "ses_r3",
      prompt: { text: "--strategy=yolo src/a.ts" },
      delivery: "steer",
    }),
  ).rejects.toThrow("--strategy")
  expect(h.prompts).toHaveLength(0)
})

test("handoff injects the invoking session id into the body", async () => {
  const h = harness()
  await mountHandoff(h.ctx)
  await h.named("handoff").execute({ sessionID: "ses_handoff_42", prompt: {}, delivery: "steer" })
  const sent = h.prompts[0]
  if (!sent) throw new Error("expected a prompt")
  expect(sent.text).toContain("ses_handoff_42")
  expect(sent.text).not.toContain("${")
  expect(sent.text).toContain("session")
})

test("handoff agent mode selects the structured contract", async () => {
  const h = harness()
  await mountHandoff(h.ctx)
  await h.named("handoff").execute({
    sessionID: "ses_h2",
    prompt: { text: "--to=agent fix the recovery path" },
    delivery: "steer",
  })
  const sent = h.prompts[0]
  if (!sent) throw new Error("expected a prompt")
  expect(sent.text).toContain("## Next task (honor these)")
  expect(sent.text).toContain("fix the recovery path")
  expect(sent.text).toContain("Mode: agent")
})

test("TUI attachments survive both commands", async () => {
  const h = harness()
  await mountRefactor(h.ctx)
  await h.named("refactor").execute({
    sessionID: "ses_a",
    prompt: { text: "src/a.ts", files: ["a.ts"], agents: ["explore"], skills: ["ast-grep"] },
    delivery: "steer",
  })
  await mountHandoff(h.ctx)
  await h.named("handoff").execute({
    sessionID: "ses_b",
    prompt: { text: "", files: ["b.ts"], agents: ["planner"], skills: ["tdd"] },
    delivery: "steer",
  })
  const first = h.prompts[0]
  const second = h.prompts[1]
  if (!first || !second) throw new Error("expected two prompts")
  expect(first.files).toEqual(["a.ts"])
  expect(first.agents).toEqual(["explore"])
  expect(first.skills).toEqual(["ast-grep"])
  expect(second.files).toEqual(["b.ts"])
  expect(second.agents).toEqual(["planner"])
  expect(second.skills).toEqual(["tdd"])
})

test("unloading is idempotent and removes every registration", async () => {
  const h = harness()
  const disposeRefactor = await mountRefactor(h.ctx)
  const disposeHandoff = await mountHandoff(h.ctx)
  expect(h.registered).toHaveLength(2)
  await disposeRefactor()
  await disposeRefactor()
  await disposeHandoff()
  expect(h.disposed).toBe(2)
  expect(h.registered).toHaveLength(0)
})
