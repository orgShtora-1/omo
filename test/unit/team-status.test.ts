import { expect, test } from "bun:test"
import {
  hasStatusBlock,
  injectStatusBlock,
  statusBlockText,
  statusTrigger,
} from "../../src/teams/status"

/** The host model-request message is `{ id?, role, content: [{ type: "text", text }] }`. */
const user = (text: string, id?: string) => ({
  ...(id ? { id } : {}),
  role: "user",
  content: [{ type: "text", text }],
})
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })

test("status block is injected once before the latest real user message that mentions teams", () => {
  const messages: unknown[] = [user("please deploy this"), user("coordinate the team now")]
  expect(injectStatusBlock({ messages })).toBe(true)
  expect(hasStatusBlock(messages)).toBe(true)
  const injected = messages.find((item) => JSON.stringify(item).includes("team_mode_status")) as {
    role: string
    content: { type: string; text: string }[]
  }
  expect(injected.role).toBe("user")
  expect(injected.content[0]).toEqual({ type: "text", text: statusBlockText() })
  expect(injectStatusBlock({ messages })).toBe(false)
  expect(messages.filter((item) => JSON.stringify(item).includes("team_mode_status"))).toHaveLength(
    1,
  )
})

test("injection is silent and absent without a matching real user message", () => {
  const quiet: unknown[] = [user("just refactor this file")]
  expect(injectStatusBlock({ messages: quiet })).toBe(false)
  expect(hasStatusBlock(quiet)).toBe(false)
  const replyOnly: unknown[] = [assistant("the team finished")]
  expect(injectStatusBlock({ messages: replyOnly })).toBe(false)
  expect(replyOnly).toHaveLength(1)
})

test("pre-existing marker blocks reinjection and malformed input fails closed", () => {
  const marked: unknown[] = [
    user("use a worker agent"),
    user(statusBlockText(), "omo-team-already-marked"),
  ]
  expect(injectStatusBlock({ messages: marked })).toBe(false)
  expect(marked).toHaveLength(2)
  for (const malformed of [null, undefined, "text", 42, {}, [null, 3]]) {
    expect(() => injectStatusBlock({ messages: malformed as unknown[] })).not.toThrow()
    expect(injectStatusBlock({ messages: malformed as unknown[] })).toBe(false)
    expect(hasStatusBlock(malformed as unknown[])).toBe(false)
  }
})

test("status trigger ignores synthetic and empty text", () => {
  expect(statusTrigger("delegate this to a subagent")).toBe(true)
  expect(statusTrigger("rename a variable")).toBe(false)
  expect(statusTrigger("")).toBe(false)
})
