import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { mountGoal } from "../../src/goal/tools"
import { mountLsp } from "../../src/lsp/tools"
import { mountMemory } from "../../src/memory/tools"
import { mountTeams } from "../../src/teams/tools"

type Collected = {
  name: string
  options: { namespace?: string; permission?: string }
  execute: (input: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>
}

function collector() {
  const tools = new Map<string, Collected>()
  return {
    tools,
    transform: async (callback: (editor: unknown) => void) => {
      callback({
        namespace() {},
        get() {
          return undefined
        },
        add(tool: Collected) {
          tools.set(tool.name, tool)
        },
      })
      return {
        dispose: async () => {},
      }
    },
  }
}

function context(
  directory: string,
  sessions: Record<string, Record<string, unknown>>,
  tools: ReturnType<typeof collector>,
): Plugin.Context {
  return {
    location: {
      directory,
      project: { id: "project", canonical: directory },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions[sessionID]
        if (!session) throw new Error(`unknown test session: ${sessionID}`)
        return session
      },
      hook: async () => ({ dispose: async () => {} }),
    },
    event: { subscribe: async function* () {} },
    tool: tools,
  } as unknown as Plugin.Context
}

const owned = (directory: string, sessionID: string) => ({
  id: sessionID,
  projectID: "project",
  location: { directory },
})

// P0-2: one fail-closed permission matrix. Mutations require `edit` (or the
// intentional legacy `task` gate for omo_team, ADR-0012); reads require
// `read`. The host enforces ALLOW/DENY/ASK on these strings before execute
// ever runs (see test/integration/permissions.test.ts for the core gate and
// test/unit/sdk-surface.test.ts for the SDK ask tripwire); each tool body
// re-checks native identity and refuses without side effects. Per-surface
// refusal proofs live in test/integration/memory.test.ts (all six tools),
// test/integration/goal-ownership.test.ts (victim file unchanged) and
// test/integration/lsp-apply-identity.test.ts (file bytes unchanged).
describe("P0-2 permission matrix", () => {
  test("mutations are edit-gated and reads are read-gated on every surface", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omo-perm-matrix-"))
    const state = await mkdtemp(join(tmpdir(), "omo-perm-matrix-state-"))
    const disposes: Array<() => Promise<void>> = []
    try {
      const memory = collector()
      disposes.push(
        await mountMemory(
          context(directory, { self: owned(directory, "self") }, memory),
          state,
          true,
        ),
      )
      expect(
        Object.fromEntries(
          [...memory.tools].map(([name, tool]) => [name, tool.options.permission]),
        ),
      ).toEqual({
        memory_save: "edit",
        memory_recall: "read",
        memory_reflect: "edit",
        memory_reflection_state: "read",
        memory_pipeline: "edit",
        memory_commit: "edit",
      })

      const goal = collector()
      disposes.push(
        await mountGoal(context(directory, { self: owned(directory, "self") }, goal), state, true),
      )
      expect(
        Object.fromEntries([...goal.tools].map(([name, tool]) => [name, tool.options.permission])),
      ).toEqual({ create_goal: "edit", update_goal: "edit", get_goal: "read" })

      const lsp = collector()
      disposes.push(
        await mountLsp(context(directory, { self: owned(directory, "self") }, lsp), {
          enabled: true,
          servers: [{ id: "ts", command: "unused", extensions: [".ts"], languageId: "typescript" }],
        }),
      )
      const reads = [
        "lsp_diagnostics",
        "lsp_definition",
        "lsp_references",
        "lsp_symbols",
        "lsp_workspace_symbols",
        "lsp_prepare_rename",
        "lsp_rename",
      ]
      for (const name of reads) expect(lsp.tools.get(name)?.options.permission).toBe("read")
      expect(lsp.tools.get("lsp_apply")?.options.permission).toBe("edit")

      const teams = collector()
      disposes.push(
        await mountTeams(
          context(directory, { leader: { id: "leader", projectID: "project" } }, teams),
          state,
          { runtime: false },
        ),
      )
      expect(teams.tools.get("team")?.options.permission).toBe("task")
    } finally {
      for (const dispose of disposes) await dispose()
      await rm(directory, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a team outsider is refused without mutating tasks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omo-perm-matrix-teams-"))
    const state = await mkdtemp(join(tmpdir(), "omo-perm-matrix-teams-state-"))
    const collected = collector()
    const ctx = context(
      directory,
      {
        leader: { id: "leader", projectID: "project" },
        child: { id: "child", projectID: "project", parentID: "leader" },
        outsider: { id: "outsider", projectID: "project", parentID: "leader" },
      },
      collected,
    )
    const cleanup = await mountTeams(ctx, state, { runtime: false })
    const tool = collected.tools.get("team")
    if (!tool) throw new Error("team tool was not registered")
    const call = (sessionID: string, input: Record<string, unknown>) =>
      tool.execute({ teamID: "t", ...input }, { sessionID })
    try {
      await call("leader", {
        action: "create",
        members: ["leader", "child"],
        tasks: [{ id: "work", dependencies: [] }],
      })
      await expect(call("outsider", { action: "task_list" })).rejects.toThrow("member-inactive")
      await expect(call("outsider", { action: "claim", taskID: "work" })).rejects.toThrow(
        "member-inactive",
      )
      const listed = (await call("leader", { action: "task_list" })) as { content: string }
      expect(JSON.parse(listed.content).map((task: { id: string }) => task.id)).toEqual(["work"])
    } finally {
      await cleanup()
      await rm(directory, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })
})
