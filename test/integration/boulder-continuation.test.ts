import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { openBoulderContext } from "../../src/boulder/context"
import { mountGoal } from "../../src/goal/tools"
import { rmRetry } from "../unit/test-utils"

type ToolRecord = {
  name: string
  execute(input: Record<string, unknown>, context: unknown): Promise<unknown>
}

interface Queued {
  type: string
  data: Record<string, unknown>
}

/**
 * Real goal continuation loop driven through the public mount, so the wiring
 * between goal continuation and boulder state is exercised end to end.
 */
function fixture(root: string) {
  const tools: ToolRecord[] = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const queue: Queued[] = []
  const wakers: Array<() => void> = []
  const ctx = {
    location: { directory: root, project: { id: "proj_wiring", canonical: root } },
    session: {
      async get(input: { sessionID: string }) {
        return {
          id: input.sessionID,
          projectID: "proj_wiring",
          location: { directory: root },
        }
      },
      async prompt(input: { sessionID: string; text: string }) {
        prompts.push(input)
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
              wakers.push(() => {
                signal.removeEventListener("abort", onAbort)
                resolve()
              })
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
          add(record: ToolRecord) {
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
    prompts,
    push(event: Queued) {
      queue.push(event)
      for (const w of wakers) w()
      wakers.length = 0
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

test("a continuation prompt carries the live boulder work context", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-boulder-continuation-"))
  let context: ReturnType<typeof openBoulderContext>
  try {
    await writeFile(join(root, "plan.md"), "- [x] Investigate\n- [ ] Ship the gate\n")
    context = openBoulderContext(root)
    const work = context.store.start("ses_wiring", "plan.md")
    const host = fixture(root)
    const dispose = await mountGoal(host.ctx, root, true, { work: context.summary })
    try {
      const create = host.tools.find((tool) => tool.name === "create_goal")
      if (!create) throw new Error("expected create_goal")
      await create.execute({ objective: "Ship parity gate" }, { sessionID: "ses_wiring" })
      host.push({ type: "session.idle", data: { sessionID: "ses_wiring" } })
      await waitFor("continuation prompt", () => host.prompts.length > 0)
      const text = host.prompts[0]?.text ?? ""
      expect(text).toContain("Ship parity gate")
      expect(text).toContain(work.id)
      expect(text).toContain("plan.md")
      expect(text).toContain("Ship the gate")
      expect(text).toContain("1/2")
    } finally {
      await dispose()
    }
  } finally {
    context?.store.close()
    await rmRetry(root)
  }
})

test("a session without live work keeps the plain continuation prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-boulder-continuation-"))
  let context: ReturnType<typeof openBoulderContext>
  try {
    await writeFile(join(root, "plan.md"), "- [ ] Ship\n")
    context = openBoulderContext(root)
    context.store.start("ses_other", "plan.md")
    context.store.transition("ses_other", "completed")
    const host = fixture(root)
    const dispose = await mountGoal(host.ctx, root, true, { work: context.summary })
    try {
      const create = host.tools.find((tool) => tool.name === "create_goal")
      if (!create) throw new Error("expected create_goal")
      await create.execute({ objective: "Ship parity gate" }, { sessionID: "ses_wiring" })
      host.push({ type: "session.idle", data: { sessionID: "ses_wiring" } })
      await waitFor("continuation prompt", () => host.prompts.length > 0)
      expect(host.prompts[0]?.text).toContain("Ship parity gate")
      expect(host.prompts[0]?.text).not.toContain("[omo work]")
      // A throwing summary provider must not stop the continuation.
      await host.push({ type: "session.idle", data: { sessionID: "ses_wiring" } })
      await waitFor("second prompt", () => host.prompts.length > 1)
    } finally {
      await dispose()
    }
  } finally {
    context?.store.close()
    await rmRetry(root)
  }
})
