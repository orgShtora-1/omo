import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { mountLsp } from "../../src/lsp/tools"

/**
 * Every tool id is refused when the host already registered one, so a project
 * configuration can never silently replace an existing tool.
 */
const IDS = [
  "omo_lsp_diagnostics",
  "omo_lsp_definition",
  "omo_lsp_references",
  "omo_lsp_symbols",
  "omo_lsp_workspace_symbols",
  "omo_lsp_prepare_rename",
  "omo_lsp_rename",
  "omo_lsp_apply",
]

test.each(IDS)("%s collision refuses the mount instead of overwriting", async (id) => {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-collision-"))
  try {
    const ctx = {
      location: { directory: root, project: { id: "project" } },
      session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }) },
      tool: {
        transform: async (register: (editor: unknown) => void) => {
          register({
            namespace() {},
            get: (name: string) => (name === id ? { name: "existing" } : undefined),
            add() {},
          })
          return { async dispose() {} }
        },
      },
    } as unknown as Plugin.Context
    await expect(
      mountLsp(ctx, {
        enabled: true,
        servers: [{ id: "ts", command: "unused", extensions: [".ts"], languageId: "typescript" }],
      }),
    ).rejects.toThrow(`LSP tool collision: ${id}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
