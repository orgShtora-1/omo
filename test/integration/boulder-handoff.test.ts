import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { mountBoulder } from "../../src/boulder/tools"
import { rmSyncRetry } from "../unit/test-utils"

type RegisteredTool = {
  name: string
  options: { permission: string }
  execute(input: unknown, context: { sessionID?: string }): Promise<{ content: string }>
}

type State = {
  work: { id: string; status: string; stale?: boolean; handedOffFrom?: string } | null
  works: Array<{ id: string; status: string; stale?: boolean }>
  invitations: Array<{ workID: string; fromSessionID: string; state: string }>
  progress: { remaining: number } | null
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "omo-boulder-handoff-"))
  writeFileSync(join(root, "plan.md"), "- [ ] remaining\n")
  writeFileSync(join(root, "other.md"), "- [x] done\n")
  const tools = new Map<string, RegisteredTool>()
  const ctx = {
    location: { directory: root, project: { id: "p", canonical: root } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        projectID: "p",
        location: { directory: root },
      }),
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            )
        },
      }),
    },
    tool: {
      transform: async (apply: (editor: unknown) => void) => {
        apply({
          namespace() {},
          get: (id: string) => tools.get(id),
          add: (tool: RegisteredTool) => {
            tools.set(`omo_${tool.name}`, tool)
          },
        })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context
  let now = Date.parse("2026-02-01T00:00:00.000Z")
  const dispose = await mountBoulder(ctx, root, true, undefined, {
    now: () => now,
    staleAfterMs: 1000,
  })
  const update = tools.get("omo_boulder_update")
  const read = tools.get("omo_boulder_state")
  if (!update || !read) throw new Error("missing boulder tools")
  const state = async (sessionID: string, input: unknown = {}): Promise<State> =>
    JSON.parse((await read.execute(input, { sessionID })).content) as State
  const call = async (sessionID: string, input: Record<string, unknown>): Promise<unknown> =>
    JSON.parse((await update.execute(input, { sessionID })).content) as unknown
  return {
    root,
    state,
    call,
    update,
    read,
    advance: (ms: number) => {
      now += ms
    },
    dispose,
    cleanup: () => rmSyncRetry(root),
  }
}

test("boulder tools expose every session work and select one by id", async () => {
  const h = await harness()
  try {
    expect((await h.state("s")).work).toBeNull()
    const first = (await h.call("s", { action: "start", plan: "plan.md" })) as {
      work: State["work"]
    }
    const second = (await h.call("s", { action: "start", plan: "other.md" })) as {
      work: State["work"]
    }
    const state = await h.state("s")
    if (!first.work || !second.work) throw new Error("missing started work")
    expect(state.works.map((work) => work.id)).toEqual([first.work.id, second.work.id])
    expect(state.work?.id).toBe(second.work.id)
    expect(state.progress?.remaining).toBe(0)
    const scoped = await h.state("s", { workID: first.work?.id })
    expect(scoped.work?.id).toBe(first.work?.id)
    expect(scoped.progress?.remaining).toBe(1)
    await h.call("s", { action: "complete", workID: second.work?.id })
    expect((await h.state("s")).work?.id).toBe(first.work?.id)
  } finally {
    await h.dispose()
    h.cleanup()
  }
})

test("handoff tools require the native session and never expose work before a claim", async () => {
  const h = await harness()
  try {
    const { work } = (await h.call("s", { action: "start", plan: "plan.md" })) as {
      work: State["work"]
    }
    const id = work?.id ?? ""
    await expect(
      h.update.execute?.({ action: "offer", workID: id, toSessionID: "t" }, {}),
    ).rejects.toThrow("native-session-required")
    expect(await h.state("t")).toMatchObject({ work: null, works: [], invitations: [] })
    await h.call("s", { action: "offer", workID: id, toSessionID: "t" })
    const invited = await h.state("t")
    expect(invited.work).toBeNull()
    expect(invited.invitations).toEqual([
      expect.objectContaining({ workID: id, fromSessionID: "s", state: "offered" }),
    ])
    await expect(h.call("bystander", { action: "claim", workID: id })).rejects.toThrow("no-handoff")
    const claimed = (await h.call("t", { action: "claim", workID: id })) as {
      work: State["work"]
    }
    expect(claimed.work).toMatchObject({ id, sessionID: "t", handedOffFrom: "s" })
    expect((await h.state("t")).works.map((work) => work.id)).toEqual([id])
    // The work left the offerer's record with the claim, so one id never has
    // two owners who could both transition or sweep it.
    expect((await h.state("s")).works.map((work) => work.id)).toEqual([])
    await expect(h.call("t", { action: "claim", workID: id })).rejects.toThrow("handoff-claimed")
    await expect(h.call("s", { action: "offer", workID: id, toSessionID: "s" })).rejects.toThrow(
      "self-handoff",
    )
  } finally {
    await h.dispose()
    h.cleanup()
  }
})

test("stale sweep flags untouched work and recovery stays explicit", async () => {
  const h = await harness()
  try {
    const { work } = (await h.call("s", { action: "start", plan: "plan.md" })) as {
      work: State["work"]
    }
    const id = work?.id ?? ""
    h.advance(2000)
    // Recovery is refused while no sweep flagged the work as stale.
    await expect(
      h.call("s", { action: "recover", workID: id, disposition: "resume" }),
    ).rejects.toThrow("stale-work-required")
    expect((await h.state("s", { workID: id })).work?.status).toBe("active")
    expect(await h.call("s", { action: "sweep" })).toEqual({ flagged: [id] })
    const stale = (await h.state("s", { workID: id })).work
    expect(stale?.stale).toBe(true)
    expect(stale?.status).toBe("active")
    await expect(
      h.call("s", { action: "recover", workID: id, disposition: "delete" }),
    ).rejects.toThrow("invalid-recovery-disposition")
    await expect(h.call("s", { action: "recover", workID: id })).rejects.toThrow(
      "recovery-disposition-required",
    )
    await expect(h.call("s", { action: "recover", disposition: "resume" })).rejects.toThrow(
      "work-id-required",
    )
    await expect(h.call("s", { action: "offer", workID: id, toSessionID: "t" })).resolves.toEqual({
      invitation: expect.objectContaining({ workID: id, fromSessionID: "s", state: "offered" }),
    })
    const resumed = (await h.call("s", {
      action: "recover",
      workID: id,
      disposition: "resume",
    })) as { work: State["work"] }
    expect(resumed.work?.stale).toBeUndefined()
    expect((await h.state("s", { workID: id })).work?.stale).toBeUndefined()
    h.advance(2000)
    await h.call("s", { action: "sweep" })
    const abandoned = (await h.call("s", {
      action: "recover",
      workID: id,
      disposition: "abandon",
    })) as { work: State["work"] }
    expect(abandoned.work?.status).toBe("abandoned")
    await expect(
      h.call("s", { action: "recover", workID: id, disposition: "resume" }),
    ).rejects.toThrow("terminal-work")
    // A terminal work is also the implicit target of ordinary transitions.
    await expect(h.call("s", { action: "pause" })).rejects.toThrow("terminal-work")
  } finally {
    await h.dispose()
    h.cleanup()
  }
})
