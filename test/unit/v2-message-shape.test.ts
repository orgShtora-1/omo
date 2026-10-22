import { expect, test } from "bun:test"
import { createCompactionIngest, createStepIngest } from "../../src/memory/ingest"
import type { Team } from "../../src/teams/model"
import { buildMailboxBlock, injectMailbox, turnMarker } from "../../src/teams/runtime"
import { hasStatusBlock, injectStatusBlock, statusBlockText } from "../../src/teams/status"

const team = (id: string, members: string[]): Team => ({
  schemaVersion: 1,
  id,
  scope: { projectID: "p", locationID: "l", parentSessionID: "parent" },
  revision: 1,
  leaderID: members[0] ?? "lead",
  members: members.map((member) => ({ id: member, active: true })),
  tasks: [],
  status: "active",
})

/**
 * The installed V2 model-request shape: `@opencode/plugin`'s SessionContext
 * exposes `messages: Array<Message>` and `@opencode/ai`'s Message is
 * `{ id?, role, content: [{ type: "text", text }] }`. There is no `parts`, no
 * `info.role` and no `synthetic` flag, so every consumer must read `role` +
 * `content` and mark its own messages with marker text and a stable id.
 */
const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
})
const assistant = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
})
const textOf = (message: { content?: unknown; id?: string }) =>
  Array.isArray(message.content)
    ? message.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown }).type === "text",
        )
        .map((part) => part.text)
        .join("\n")
    : ""

test("step ingestion derives text from V2 message content parts", async () => {
  const seen: string[] = []
  const ingest = createStepIngest({
    enqueue: (snapshot) => {
      seen.push(snapshot.text)
      return true
    },
    admit: () => undefined,
  })
  const outcome = await ingest({
    sessionID: "s",
    messages: [user("first request"), assistant("answer"), user("latest request")],
  })
  expect(outcome).toBe("ingested")
  expect(seen).toEqual(["user: first request\nassistant: answer\nuser: latest request"])
})

test("compaction ingestion derives text from V2 content when the host has no summary", async () => {
  const seen: string[] = []
  const ingest = createCompactionIngest({
    enqueue: (snapshot) => {
      seen.push(snapshot.text)
      return true
    },
    admit: () => undefined,
  })
  expect(
    await ingest({ sessionID: "s", result: {}, messages: [user("remember the release gate")] }),
  ).toBe("ingested")
  expect(seen).toEqual(["user: remember the release gate"])
})

test("the status block is injected before the latest real V2 user message and never twice", () => {
  const messages = [user("coordinate the team please"), assistant("sure")]
  expect(injectStatusBlock({ messages })).toBe(true)
  const injected = messages.find((message) => textOf(message).includes("<team_mode_status"))
  if (!injected) throw new Error("expected an injected message")
  expect(textOf(injected)).toBe(statusBlockText())
  // The injected message is not a real user message, so it cannot trigger itself.
  expect(injectStatusBlock({ messages })).toBe(false)
  expect(hasStatusBlock(messages)).toBe(true)
  expect(messages).toHaveLength(3)
})

test("mailbox injection appends a decodable V2 message once per turn marker", () => {
  const messages: Record<string, unknown>[] = [user("keep going")]
  const block = buildMailboxBlock(
    [team("team", ["s"])],
    [
      {
        teamID: "team",
        senderID: "lead",
        body: "review this",
        createdAt: 1,
        id: "m1",
        acknowledgedAt: null,
      },
    ],
  )
  if (typeof block !== "string") throw new Error("expected a mailbox block")
  expect(block).toContain("review this")
  expect(injectMailbox(messages, block, "turn-1")).toBe(true)
  expect(injectMailbox(messages, block, "turn-1")).toBe(false)
  const injected = messages[messages.length - 1]
  if (!injected) throw new Error("expected an injected message")
  expect(textOf(injected)).toBe(block)
  expect(injected.role).toBe("user")
  expect(injected.id).toBe("omo-team-turn-1")
  // The marker only counts real messages, so a second request cannot duplicate.
  expect(turnMarker("s", [user("keep going")])).toBe(turnMarker("s", messages))
})

test("the turn marker ignores anything this plugin injected", () => {
  const messages: Record<string, unknown>[] = [user("first"), user("second")]
  const before = turnMarker("s", messages)
  const block = buildMailboxBlock(
    [team("team", ["s"])],
    [
      {
        teamID: "team",
        senderID: "lead",
        body: "review",
        createdAt: 1,
        id: "m1",
        acknowledgedAt: null,
      },
    ],
  )
  if (typeof block !== "string") throw new Error("expected a mailbox block")
  injectMailbox(messages, block, before)
  expect(turnMarker("s", messages)).toBe(before)
  expect(turnMarker(" ", messages)).toBe("")
})
