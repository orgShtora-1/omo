import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { openBoulderContext } from "../../src/boulder/context"
import { mountBoulder } from "../../src/boulder/tools"

interface Queued {
  type: string
  data: Record<string, unknown>
}

function fixture(root: string) {
  const tools: Array<{
    name: string
    execute(input: Record<string, unknown>, context: unknown): Promise<unknown>
  }> = []
  const queue: Queued[] = []
  let wake: (() => void) | undefined
  const ctx = {
    location: { directory: root, project: { id: "proj_live", canonical: root } },
    session: {
      async get(input: { sessionID: string }) {
        return {
          id: input.sessionID,
          projectID: input.sessionID === "ses_foreign" ? "other" : "proj_live",
          location: { directory: root },
        }
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            const next = queue.shift()
            if (next) {
              yield next
              continue
            }
            await new Promise<void>((resolve) => {
              const onAbort = () => {
                signal.removeEventListener("abort", onAbort)
                resolve()
              }
              signal.addEventListener("abort", onAbort, { once: true })
              wake = () => {
                signal.removeEventListener("abort", onAbort)
                resolve()
              }
            })
          }
        },
      }),
    },
    tool: {
      async transform(callback: (editor: unknown) => unknown) {
        callback({
          namespace() {},
          get() {
            return undefined
          },
          add(record: (typeof tools)[number]) {
            tools.push(record)
          },
        })
        return { dispose() {} }
      },
    },
  }
  return {
    ctx: ctx as unknown as Plugin.Context,
    tools,
    push(event: Queued) {
      queue.push(event)
      wake?.()
    },
  }
}

async function waitFor(what: string, ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

test("compaction refreshes only the compacting session's own live work", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-boulder-compaction-"))
  try {
    await writeFile(join(root, "plan.md"), "- [ ] Ship\n")
    let now = Date.parse("2026-03-01T00:00:00.000Z")
    const context = openBoulderContext(root, { now: () => now, staleAfterMs: 1000 })
    const host = fixture(root)
    const dispose = await mountBoulder(host.ctx, root, true, context.store)
    try {
      const update = host.tools.find((tool) => tool.name === "boulder_update")
      if (!update) throw new Error("missing boulder_update")
      await update.execute({ action: "start", plan: "plan.md" }, { sessionID: "ses_live" })
      const before = context.store.get("ses_live")
      if (!before) throw new Error("missing work")
      now += 5_000
      host.push({ type: "session.compaction.ended", data: { sessionID: "ses_live" } })
      await waitFor(
        "refreshed work",
        () => context.store.get("ses_live")?.updatedAt !== before.updatedAt,
      )
      const after = context.store.get("ses_live")
      expect(after?.updatedAt).not.toBe(before.updatedAt)
      expect(after?.status).toBe("active")
      // A foreign session id must never refresh this session's records.
      now += 5_000
      const refreshed = after?.updatedAt
      host.push({ type: "session.compaction.ended", data: { sessionID: "ses_foreign" } })
      host.push({ type: "session.compaction.ended", data: {} })
      host.push({ type: "session.idle", data: { sessionID: "ses_live" } })
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(context.store.get("ses_live")?.updatedAt).toBe(refreshed)
      // Compaction is a liveness signal: it does not clear a sweep's stale flag.
      now += 10_000
      host.push({ type: "session.compaction.ended", data: { sessionID: "ses_live" } })
      await waitFor("second refresh", () => context.store.get("ses_live")?.updatedAt !== refreshed)
      expect(context.store.get("ses_live")?.stale).toBeUndefined()
    } finally {
      await dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a disabled boulder mount never subscribes or refreshes", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-boulder-compaction-"))
  try {
    await writeFile(join(root, "plan.md"), "- [ ] Ship\n")
    const context = openBoulderContext(root)
    context.store.start("ses_live", "plan.md")
    const before = context.store.get("ses_live")?.updatedAt
    const host = fixture(root)
    const dispose = await mountBoulder(host.ctx, root, false, context.store)
    try {
      expect(host.tools).toHaveLength(0)
      host.push({ type: "session.compaction.ended", data: { sessionID: "ses_live" } })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(context.store.get("ses_live")?.updatedAt).toBe(before)
    } finally {
      await dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
