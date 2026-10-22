import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { hasStatusBlock } from "../../src/teams/status"
import { mountTeams } from "../../src/teams/tools"

interface Recorded {
  contexts: number
  gates: Array<{ tool: string; sessionID: string }>
  prompts: Array<{ sessionID: string; text: string }>
  queued: unknown[]
  signal?: AbortSignal
  release?: () => void
}

async function fixture(
  options: { quiet?: { intervalMs?: number; quietMs?: number; now?: () => number } } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "omo team runtime "))
  const stateDir = await mkdtemp(join(tmpdir(), "omo team runtime state "))
  const recorded: Recorded = { contexts: 0, gates: [], prompts: [], queued: [] }
  let team: {
    execute(
      args: Record<string, unknown>,
      context: { sessionID: string },
    ): Promise<{ content: string; output?: unknown }>
  }
  type Handler = (event: { tool: string; sessionID: string; input: unknown }) => Promise<void>
  let gateHandler: Handler | undefined
  type ContextHandler = (input: { sessionID: string; messages: unknown[] }) => Promise<void>
  let contextHandler: ContextHandler | undefined
  const ctx = {
    location: { directory, project: { id: "p", canonical: directory } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        projectID: "p",
        ...(sessionID === "leader" ? {} : { parentID: "leader" }),
      }),
      prompt: async (input: { sessionID: string; text: string }) => {
        recorded.prompts.push(input)
      },
      hook: async (_name: string, handler: ContextHandler) => {
        if (_name !== "context") throw new Error(`unexpected hook ${_name}`)
        contextHandler = handler
        recorded.contexts += 1
        return {
          dispose: async () => {
            recorded.contexts -= 1
            contextHandler = undefined
          },
        }
      },
    },
    tool: {
      transform: async (callback: (editor: { get(): void; add(value: unknown): void }) => void) => {
        callback({
          get() {},
          add(value: unknown) {
            team = value as typeof team
          },
        })
        return { dispose: async () => {} }
      },
      hook: async (_name: string, handler: Handler) => {
        if (_name !== "execute.before") throw new Error(`unexpected hook ${_name}`)
        gateHandler = handler
        return { dispose: async () => (gateHandler = undefined) }
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        recorded.signal = signal
        let pending: (() => void) | undefined
        recorded.release = () => pending?.()
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<unknown>>((resolve) => {
                const value = recorded.queued.shift()
                if (value !== undefined) return resolve({ done: false, value })
                if (signal.aborted) return resolve({ done: true, value: undefined })
                // The loop parks here; a later push must release this exact promise.
                pending = () => {
                  pending = undefined
                  const next = recorded.queued.shift()
                  resolve(
                    next !== undefined
                      ? { done: false, value: next }
                      : { done: true, value: undefined },
                  )
                }
                signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
                  once: true,
                })
              }),
          }),
        }
      },
    },
  }
  const dispose = await mountTeams(ctx as unknown as Plugin.Context, stateDir, options)
  const call = (args: Record<string, unknown>, sessionID: string) => {
    if (!team) throw new Error("missing team tool")
    return team.execute(args, { sessionID })
  }
  const gate = (input: Record<string, unknown>, sessionID: string, tool = "omo_team") => {
    if (!gateHandler) throw new Error("missing gate hook")
    recorded.gates.push({ tool, sessionID })
    return gateHandler({ tool, sessionID, input })
  }
  const context = async (sessionID: string, existing?: unknown[]) => {
    if (!contextHandler) throw new Error("missing context hook")
    const messages: unknown[] = existing ?? []
    await contextHandler({ sessionID, messages })
    return messages
  }
  const idle = async (sessionID: string) => {
    const before = recorded.prompts.length
    recorded.queued.push({ type: "session.idle", data: { sessionID } })
    recorded.release?.()
    for (let attempt = 0; attempt < 100 && recorded.prompts.length === before; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const create = {
    action: "create",
    teamID: "team",
    members: ["leader", "alice"],
    tasks: [{ id: "build", dependencies: [] }],
  }
  return {
    dispose,
    recorded,
    call,
    gate,
    context,
    idle,
    create,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}

test("team runtime gates outsiders, injects pending mail once and wakes an idle member", async () => {
  const { dispose, recorded, call, gate, context, idle, create, cleanup } = await fixture()
  try {
    await call(create, "leader")
    await call(
      {
        action: "send",
        teamID: "team",
        recipientID: "alice",
        body: "please build",
        dedupKey: "m1",
      },
      "leader",
    )

    // A non-member is not shown the team at all, so the gate denies with the
    // non-disclosing reason instead of confirming the team exists.
    await expect(gate({ action: "task_list", teamID: "team" }, "stranger")).rejects.toThrow(
      /unknown-team/,
    )
    await expect(gate({ action: "delete", teamID: "team" }, "alice")).rejects.toThrow(/lead-only/)
    await gate({ action: "task_list", teamID: "team" }, "alice")
    await gate({ action: "task_list", teamID: "team" }, "stranger2", "omo_parallel")
    expect(recorded.gates.filter((entry) => entry.tool === "omo_parallel")).toHaveLength(1)

    const injected = await context("alice")
    // The status notice is spliced before the real user message and the mailbox
    // block is appended, so locate the mailbox message instead of assuming index.
    const mailbox = injected.find((message) =>
      JSON.stringify(message).includes("team_mailbox"),
    ) as { content: { text: string }[] }
    const part = mailbox.content[0]
    expect(part?.text).toContain('<team_mailbox team="team" pending="1">')
    expect(part?.text).toContain("please build")
    // The marker counts only real messages, so a second model request over the
    // same conversation (already containing the injected block) injects nothing.
    const reused = await context("alice", injected)
    expect(reused).toHaveLength(1)
    // A fresh conversation with no injected message injects exactly one mailbox block
    // (the status notice is counted separately because it answers a different rule).
    const fresh = await context("alice")
    expect(
      fresh.filter((message) => JSON.stringify(message).includes("team_mailbox")),
    ).toHaveLength(1)
    // A member with an empty mailbox receives nothing.
    expect(await context("leader")).toHaveLength(0)

    await idle("alice")
    expect(recorded.prompts).toHaveLength(1)
    expect(recorded.prompts[0]?.sessionID).toBe("alice")
    expect(recorded.prompts[0]?.text).toContain("please build")
    // Already hinted mail never wakes the session twice.
    await idle("alice")
    expect(recorded.prompts).toHaveLength(1)
    // A session with no pending mail is never woken.
    await idle("leader")
    expect(recorded.prompts).toHaveLength(1)
  } finally {
    await dispose()
    await cleanup()
  }
})

test("the context hook injects the team-mode status block for a team request exactly once", async () => {
  const { dispose, call, context, create, cleanup } = await fixture()
  try {
    await call(create, "leader")
    const asking = [
      { role: "user", content: [{ type: "text", text: "coordinate the team please" }] },
    ]
    const injected = await context("leader", asking)
    expect(injected).toHaveLength(2)
    expect(hasStatusBlock(injected)).toBe(true)
    // The notice is idempotent even when a later turn reuses the same messages.
    expect(await context("leader", injected)).toHaveLength(2)
    // A request that does not mention teams stays untouched.
    expect(
      await context("leader", [
        { role: "user", content: [{ type: "text", text: "rename this variable" }] },
      ]),
    ).toHaveLength(1)
  } finally {
    await dispose()
    await cleanup()
  }
})

test("team runtime stops injecting, gating and waking after unload", async () => {
  const { dispose, recorded, call, gate, context, create, cleanup } = await fixture()
  await call(create, "leader")
  await call(
    { action: "send", teamID: "team", recipientID: "alice", body: "ping", dedupKey: "m2" },
    "leader",
  )
  await dispose()
  expect(recorded.contexts).toBe(0)
  expect(recorded.signal?.aborted).toBe(true)
  expect(() => gate({ action: "task_list", teamID: "team" }, "alice")).toThrow(/missing gate hook/)
  expect(() => context("alice")).toThrow(/missing context hook/)
  expect(recorded.prompts).toHaveLength(0)
  await cleanup()
})

test("the quiet window ignores status heartbeats and still wakes the session", async () => {
  const { dispose, recorded, call, create, cleanup } = await fixture({
    quiet: { intervalMs: 10, quietMs: 150 },
  })
  try {
    await call(create, "leader")
    await call(
      {
        action: "send",
        teamID: "team",
        recipientID: "leader",
        body: "quiet please",
        dedupKey: "q1",
      },
      "leader",
    )
    // One real output event seeds activity.
    recorded.queued.push({ type: "session.reasoning.delta", data: { sessionID: "leader" } })
    recorded.release?.()
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The managed host emits status/usage heartbeats in volume; they are not
    // work, so they must not keep the quiet window open forever.
    for (let beat = 0; beat < 10; beat++) {
      recorded.queued.push(
        beat % 2 === 0
          ? { type: "session.status", data: { sessionID: "leader", status: { type: "busy" } } }
          : { type: "session.usage.updated", data: { sessionID: "leader" } },
      )
      recorded.release?.()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(recorded.prompts).toHaveLength(1)
    expect(recorded.prompts[0]?.sessionID).toBe("leader")
    expect(recorded.prompts[0]?.text).toContain("quiet please")
  } finally {
    await dispose()
    await cleanup()
  }
})

test("pending mail wakes a busy session exactly once", async () => {
  const { dispose, recorded, call, create, cleanup } = await fixture({
    quiet: { intervalMs: 10, quietMs: 150 },
  })
  try {
    await call(create, "leader")
    await call(
      { action: "send", teamID: "team", recipientID: "leader", body: "hold on", dedupKey: "q2" },
      "leader",
    )
    // The session keeps producing output the whole time: the managed host never
    // goes idle, so the wake is driven by pending mail, not stream silence. The
    // one-shot hint must still keep it to a single prompt.
    for (let beat = 0; beat < 15; beat++) {
      recorded.queued.push({ type: "session.reasoning.delta", data: { sessionID: "leader" } })
      recorded.release?.()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(recorded.prompts).toHaveLength(1)
    expect(recorded.prompts[0]?.sessionID).toBe("leader")
    expect(recorded.prompts[0]?.text).toContain("hold on")
  } finally {
    await dispose()
    await cleanup()
  }
})

test("activity from another session does not hold the parent's quiet window open", async () => {
  const { dispose, recorded, call, create, cleanup } = await fixture({
    quiet: { intervalMs: 10, quietMs: 150 },
  })
  try {
    await call(create, "leader")
    await call(
      {
        action: "send",
        teamID: "team",
        recipientID: "leader",
        body: "other session noise",
        dedupKey: "q3",
      },
      "leader",
    )
    // One real output event seeds the parent's activity.
    recorded.queued.push({ type: "session.reasoning.delta", data: { sessionID: "leader" } })
    recorded.release?.()
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Another session keeps emitting work; the parent's window must still open.
    for (let beat = 0; beat < 12; beat++) {
      recorded.queued.push({ type: "session.reasoning.delta", data: { sessionID: "someone-else" } })
      recorded.release?.()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(recorded.prompts).toHaveLength(1)
    expect(recorded.prompts[0]?.sessionID).toBe("leader")
    expect(recorded.prompts[0]?.text).toContain("other session noise")
  } finally {
    await dispose()
    await cleanup()
  }
})
