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
type Editor = {
  namespace(): void
  get(id: string): RegisteredTool | undefined
  add(tool: RegisteredTool): void
}

test("boulder tools enforce native project ownership and separate read/edit gates", async () => {
  const root = mkdtempSync(join(tmpdir(), "omo-boulder-tools-"))
  const tools = new Map<string, RegisteredTool>()
  let projectID = "p"
  let disposed = false
  const ctx = {
    location: { directory: root, project: { id: "p", canonical: root } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        projectID,
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
      transform: async (apply: (editor: Editor) => void) => {
        apply({
          namespace() {},
          get: (id: string) => tools.get(id),
          add: (tool: RegisteredTool) => {
            tools.set(`omo_${tool.name}`, tool)
          },
        })
        return {
          dispose: async () => {
            disposed = true
          },
        }
      },
    },
  } as unknown as Plugin.Context
  let dispose = async () => {}
  try {
    writeFileSync(join(root, "plan.md"), "- [ ] remaining\n")
    await mountBoulder(ctx, root, false)
    expect(tools.size).toBe(0)
    dispose = await mountBoulder(ctx, root, true)
    expect(tools.get("omo_boulder_update")?.options.permission).toBe("edit")
    expect(tools.get("omo_boulder_state")?.options.permission).toBe("read")
    const update = tools.get("omo_boulder_update")
    const read = tools.get("omo_boulder_state")
    if (!update || !read) throw new Error("missing boulder tools")
    await expect(update.execute({ action: "start", plan: "plan.md" }, {})).rejects.toThrow(
      "native-session-required",
    )
    projectID = "foreign"
    await expect(
      update.execute({ action: "start", plan: "plan.md" }, { sessionID: "s" }),
    ).rejects.toThrow("foreign-session")
    projectID = "p"
    expect(JSON.parse((await read.execute({}, { sessionID: "s" })).content).work).toBeNull()
    await update.execute({ action: "start", plan: "plan.md" }, { sessionID: "s" })
    expect(
      JSON.parse((await read.execute({}, { sessionID: "s" })).content).progress.remaining,
    ).toBe(1)
    expect(JSON.parse((await read.execute({}, { sessionID: "other" })).content).work).toBeNull()
    await update.execute({ action: "pause" }, { sessionID: "s" })
    expect(JSON.parse((await read.execute({}, { sessionID: "s" })).content).work.status).toBe(
      "paused",
    )
  } finally {
    await dispose()
    expect(disposed).toBe(true)
    rmSyncRetry(root)
  }
})
