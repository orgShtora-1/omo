import { expect, test } from "bun:test"
import {
  curateSessionInfo,
  MAX_SESSION_MESSAGES,
  MESSAGE_PREVIEW_LIMIT,
  summarizeSessionMessages,
} from "../../src/sessions/curate"

test("curateSessionInfo keeps identity fields and drops host internals", () => {
  const view = curateSessionInfo({
    id: "s",
    parentID: "p",
    projectID: "proj",
    agent: "explore",
    model: { providerID: "opencode", modelID: "m" },
    cost: 0,
    tokens: { input: 1, output: 2 },
    outcome: "succeeded",
    title: "probe",
    time: { created: 1, updated: 2 },
    metadata: { secret: true },
    permissions: [{ action: "shell", resource: "*", effect: "deny" }],
    location: "/tmp",
    revert: { messageID: "mid" },
  })
  expect(view).toEqual({
    id: "s",
    parentID: "p",
    projectID: "proj",
    agent: "explore",
    model: { providerID: "opencode", modelID: "m" },
    cost: 0,
    tokens: { input: 1, output: 2 },
    outcome: "succeeded",
    title: "probe",
    time: { created: 1, updated: 2 },
  })
  expect(view).not.toHaveProperty("metadata")
  expect(view).not.toHaveProperty("permissions")
  expect(view).not.toHaveProperty("location")
  expect(view).not.toHaveProperty("revert")
})

test("curateSessionInfo omits absent optionals instead of nulling them", () => {
  const view = curateSessionInfo({ id: "s", projectID: "proj" })
  expect(view).toEqual({ id: "s", projectID: "proj" })
  expect(view).not.toHaveProperty("parentID")
  expect(view).not.toHaveProperty("agent")
})

test("summarizeSessionMessages previews user text with truncation", () => {
  const long = "x".repeat(MESSAGE_PREVIEW_LIMIT + 10)
  const [summary] = summarizeSessionMessages([{ type: "user", text: long }])
  expect(summary?.type).toBe("user")
  expect(summary?.preview).toBe(
    `${"x".repeat(MESSAGE_PREVIEW_LIMIT)}\n[output truncated by shtora.omo tool guard]`,
  )
  const [short] = summarizeSessionMessages([{ type: "user", text: "hello" }])
  expect(short).toEqual({ type: "user", preview: "hello" })
})

test("summarizeSessionMessages joins assistant text and names tool parts", () => {
  const [summary] = summarizeSessionMessages([
    {
      type: "assistant",
      agent: "explore",
      content: [
        { type: "text", text: "thinking out loud" },
        { type: "tool", tool: "read" },
        { type: "text", text: "done" },
      ],
    },
  ])
  expect(summary?.type).toBe("assistant")
  expect(summary?.preview).toContain("thinking out loud")
  expect(summary?.preview).toContain("[tool read]")
  expect(summary?.preview).toContain("done")
})

test("summarizeSessionMessages keeps only the newest messages and never throws", () => {
  const messages = Array.from({ length: MAX_SESSION_MESSAGES + 10 }, (_, index) => ({
    type: "user",
    text: `message ${index}`,
  }))
  const summaries = summarizeSessionMessages(messages)
  expect(summaries).toHaveLength(MAX_SESSION_MESSAGES)
  expect(summaries[0]?.preview).toBe(`message 10`)
  expect(summaries[MAX_SESSION_MESSAGES - 1]?.preview).toBe(`message ${MAX_SESSION_MESSAGES + 9}`)
  expect(summarizeSessionMessages([null, 42, { nope: true }])).toEqual([
    { type: "unknown", preview: "" },
    { type: "unknown", preview: "" },
    { type: "unknown", preview: "" },
  ])
})
