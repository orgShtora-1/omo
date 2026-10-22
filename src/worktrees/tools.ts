import type { Plugin } from "@opencode/plugin"
import { openWorktreeManager, type WorktreeManager } from "./manager"

export async function mountWorktrees(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const managers = new Map<string, Promise<WorktreeManager>>()
  const pending = new Set<Promise<unknown>>()
  let disposed = false
  const registration = await ctx.tool.transform((editor) => {
    if (editor.get("omo_worktree")) throw new Error("tool collision: omo_worktree")
    editor.add({
      name: "worktree",
      description:
        "Prepare, inspect, recover and integrate owned isolated Git checkouts. Only the native parent leader may integrate reviewed commits or clean owned worktrees. Returns checkout path for an explicitly located worker.",
      options: { namespace: "omo", permission: "shell" },
      output: {},
      input: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: {
            enum: ["prepare", "list", "inspect", "recover", "integrate", "abort", "cleanup"],
          },
          taskID: { type: "string" },
          handleID: { type: "string" },
          expectedHead: { type: "string" },
          reviewedCommit: { type: "string" },
        },
      },
      async execute(raw, context) {
        if (disposed) throw new Error("runtime closed")
        const operation = (async () => {
          const input = raw as Record<string, string>
          const session = await ctx.session.get({ sessionID: context.sessionID })
          if (session.projectID !== ctx.location.project.id) throw new Error("foreign-project")
          const parentID = session.parentID ?? context.sessionID
          const action = input.action
          if (
            context.sessionID !== parentID &&
            typeof action === "string" &&
            ["prepare", "integrate", "abort", "cleanup"].includes(action)
          )
            throw new Error("leader-required")
          let opening = managers.get(parentID)
          if (!opening) {
            opening = openWorktreeManager(ctx.location.directory, {
              projectID: session.projectID,
              parentSessionID: parentID,
            })
            managers.set(parentID, opening)
            opening.catch(() => managers.delete(parentID))
          }
          const manager = await opening
          let output: unknown
          if (input.action === "list") output = manager.list()
          else if (input.action === "prepare") {
            if (!input.taskID?.trim()) throw new Error("taskID required")
            output = await manager.prepareWorktree(input.taskID, context.signal)
          } else {
            const handle = manager.list().find((value) => value.id === input.handleID)
            if (!handle) throw new Error("not-owned: handleID")
            switch (input.action) {
              case "inspect":
                output = await manager.inspectChanges(handle)
                break
              case "recover":
                output = await manager.recoverWorktree(handle)
                break
              case "cleanup":
                output = await manager.cleanup(handle)
                break
              case "abort":
                output = await manager.abortIntegration(handle)
                break
              case "integrate": {
                if (!input.expectedHead || !input.reviewedCommit)
                  throw new Error("expectedHead and reviewedCommit required")
                output = await manager.integrate(handle, {
                  strategy: "merge",
                  expectedHead: input.expectedHead,
                  reviewedCommit: input.reviewedCommit,
                })
                break
              }
              default:
                throw new Error("unknown worktree action")
            }
          }
          return { output, content: JSON.stringify(output ?? { ok: true }) }
        })()
        pending.add(operation)
        try {
          return await operation
        } finally {
          pending.delete(operation)
        }
      },
    })
  })
  return async () => {
    if (disposed) return
    disposed = true
    await registration.dispose()
    await Promise.allSettled(pending)
    for (const manager of managers.values())
      try {
        ;(await manager).close()
      } catch {
        /* Failed open owns no manager. */
      }
  }
}
