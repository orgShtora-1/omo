import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { mountSessions } from "../../src/sessions/tools"

interface SessionToolResult {
  content: string
  output?: unknown
}

interface SessionToolHandle {
  execute: (
    args: Record<string, unknown>,
    context: { sessionID: string },
  ) => Promise<SessionToolResult>
}

interface SessionRecord {
  id: string
  projectID: string
  parentID?: string
}

const records: Record<string, SessionRecord> = {
  s: { id: "s", projectID: "p", parentID: "p1" },
  p1: { id: "p1", projectID: "p", parentID: "p0" },
  p0: { id: "p0", projectID: "p" },
  x: { id: "x", projectID: "p", parentID: "p1" },
  y: { id: "y", projectID: "q" },
}

const contexts: Record<string, Array<Record<string, unknown>>> = {
  s: [
    { type: "user", text: "probe the session" },
    { type: "assistant", content: [{ type: "text", text: "on it" }] },
  ],
}

function fixture() {
  let tool: SessionToolHandle | undefined
  const ctx = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const record = records[sessionID]
        if (!record) throw new Error(`session-not-found: ${sessionID}`)
        return record
      },
      context: async ({ sessionID }: { sessionID: string }) => contexts[sessionID] ?? [],
    },
    tool: {
      transform: async (
        callback: (api: {
          get(): undefined
          namespace(value: { name: string }): void
          add(value: SessionToolHandle): void
        }) => void,
      ) => {
        callback({
          get: () => undefined,
          namespace: () => {},
          add: (value) => {
            tool = value
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  const handle = (): SessionToolHandle => {
    if (!tool) throw new Error("session tool was not registered")
    return tool
  }
  return { ctx: ctx as unknown as Plugin.Context, handle }
}

test("session tool exposes read-only info and context over the ancestor chain", async () => {
  const { ctx, handle } = fixture()
  const cleanup = await mountSessions(ctx)
  try {
    const self = await handle().execute({ action: "info" }, { sessionID: "s" })
    expect(JSON.parse(self.content)).toEqual({ id: "s", parentID: "p1", projectID: "p" })
    const parent = await handle().execute({ action: "info", sessionID: "p1" }, { sessionID: "s" })
    expect(JSON.parse(parent.content)).toEqual({ id: "p1", parentID: "p0", projectID: "p" })
    const grandparent = await handle().execute(
      { action: "info", sessionID: "p0" },
      { sessionID: "s" },
    )
    expect(JSON.parse(grandparent.content)).toEqual({ id: "p0", projectID: "p" })
    await expect(
      handle().execute({ action: "info", sessionID: "x" }, { sessionID: "s" }),
    ).rejects.toThrow("foreign-session")
    await expect(
      handle().execute({ action: "info", sessionID: "y" }, { sessionID: "s" }),
    ).rejects.toThrow("foreign-session")
    await expect(
      handle().execute({ action: "info", sessionID: "ghost" }, { sessionID: "s" }),
    ).rejects.toThrow("session-not-found")
    const context = await handle().execute({ action: "context" }, { sessionID: "s" })
    expect(JSON.parse(context.content)).toEqual([
      { type: "user", preview: "probe the session" },
      { type: "assistant", preview: "on it" },
    ])
    await expect(handle().execute({ action: "delete" }, { sessionID: "s" })).rejects.toThrow(
      "unknown session action",
    )
  } finally {
    await cleanup()
  }
})

test("session registration is a read-only omo tool", async () => {
  const registrations: Array<{
    name: string
    options?: { namespace?: string; permission?: string }
  }> = []
  const ctx = {
    tool: {
      transform: async (
        callback: (editor: {
          get(): undefined
          namespace(value: { name: string }): void
          add(value: (typeof registrations)[number]): void
        }) => void,
      ) => {
        callback({
          get: () => undefined,
          namespace: () => {},
          add: (value) => registrations.push(value),
        })
        return { dispose: async () => {} }
      },
    },
  }
  const cleanup = await mountSessions(ctx as unknown as Plugin.Context)
  try {
    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({
      name: "session",
      options: { namespace: "omo", permission: "read" },
    })
  } finally {
    await cleanup()
  }
})
