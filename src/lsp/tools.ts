import { readFile } from "node:fs/promises"
import type { Plugin } from "@opencode/plugin"
import { applyWorkspaceEdit } from "./apply"
import { fileUri, type Position } from "./client"
import { LspServers, parseLspOptions } from "./servers"

/** Optional resources are lazy and scoped to configured roots. */
export async function mountLsp(ctx: Plugin.Context, input: unknown): Promise<() => Promise<void>> {
  const options = parseLspOptions(input, ctx.location.directory)
  if (!options.enabled) return async () => {}
  const servers = new LspServers(options)
  const controller = new AbortController()
  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omo", description: "OMO project workflow and code intelligence" })
    for (const operation of [
      "diagnostics",
      "definition",
      "references",
      "symbols",
      "workspace_symbols",
      "prepare_rename",
      "rename",
    ] as const) {
      const id = `omo_lsp_${operation}`
      if (editor.get(id)) throw new Error(`LSP tool collision: ${id}`)
      editor.add({
        name: `lsp_${operation}`,
        description: `Configured LSP ${operation}. File relative to server root; positions are zero-based UTF-16. Diagnostics waits for publication. Rename returns a WorkspaceEdit proposal with applied=false; it NEVER modifies files. Review it and use lsp_apply with SHA-256 hashes of the reviewed files under the native edit permission.`,
        options: { namespace: "omo", permission: "read" },
        output: {},
        input: {
          type: "object",
          properties: {
            file: { type: "string" },
            serverID: { type: "string" },
            line: { type: "integer", minimum: 0 },
            character: { type: "integer", minimum: 0 },
            includeDeclaration: { type: "boolean" },
            newName: { type: "string", minLength: 1 },
            query: { type: "string", maxLength: 4096 },
          },
          required:
            operation === "workspace_symbols"
              ? ["file", "query"]
              : operation === "diagnostics" || operation === "symbols"
                ? ["file"]
                : operation === "rename"
                  ? ["file", "line", "character", "newName"]
                  : ["file", "line", "character"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const args = input as {
            file: string
            serverID?: string
            line: number
            character: number
            includeDeclaration?: boolean
            newName?: string
            query?: string
          }
          const signal = AbortSignal.any([controller.signal, context.signal])
          signal.throwIfAborted()
          const { config, file } = await servers.document(args.file, args.serverID)
          const value = await servers.use(config, async (handle) => {
            signal.throwIfAborted()
            if (operation === "workspace_symbols") {
              if (typeof args.query !== "string") throw new Error("query is required")
              return handle.workspaceSymbols(args.query, signal)
            }
            const text = await readFile(file, "utf8")
            const uri = fileUri(file)
            await handle.openDocument(uri, config.languageId, text)
            const position: Position = { line: args.line, character: args.character }
            if (operation === "diagnostics") return handle.diagnostics(uri, signal)
            if (operation === "definition") return handle.definition(uri, position, signal)
            if (operation === "symbols") return handle.symbols(uri, signal)
            if (operation === "prepare_rename") return handle.prepareRename(uri, position, signal)
            if (operation === "rename") {
              if (typeof args.newName !== "string") throw new Error("newName is required")
              return {
                applied: false,
                edit: await handle.rename(uri, position, args.newName, signal),
              }
            }
            return handle.references(uri, position, args.includeDeclaration ?? true, signal)
          })
          return { output: value, content: JSON.stringify(value) }
        },
      })
    }
    if (editor.get("omo_lsp_apply")) throw new Error("LSP tool collision: omo_lsp_apply")
    editor.add({
      name: "lsp_apply",
      description:
        "Apply a reviewed WorkspaceEdit under native edit permission. Supply the configured server ID and SHA-256 of each reviewed file keyed by its exact file URI. Rejects stale content, external paths, overlapping edits and resource operations. Not crash-atomic across files.",
      options: { namespace: "omo", permission: "edit" },
      output: {},
      input: {
        type: "object",
        properties: {
          serverID: { type: "string", minLength: 1 },
          edit: { type: "object" },
          expectedHashes: {
            type: "object",
            additionalProperties: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
        required: ["serverID", "edit", "expectedHashes"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const signal = AbortSignal.any([controller.signal, context.signal])
        signal.throwIfAborted()
        const sessionID = context.sessionID
        if (typeof sessionID !== "string" || !sessionID.trim())
          throw new Error("native-session-required")
        const session = await ctx.session.get({ sessionID }, { signal })
        if (
          session.id !== sessionID ||
          session.projectID !== ctx.location.project.id ||
          session.location.directory !== ctx.location.directory
        )
          throw new Error("foreign-session")
        const args = input as {
          serverID: string
          edit: unknown
          expectedHashes: Record<string, string>
        }
        const server = options.servers.find((item) => item.id === args.serverID)
        if (!server) throw new Error("unknown-server")
        const value = await applyWorkspaceEdit(server.root, args.edit, args.expectedHashes, signal)
        return { output: value, content: JSON.stringify(value) }
      },
    })
  })
  let cleanup: Promise<void> | undefined
  return () =>
    (cleanup ??= (async () => {
      controller.abort()
      try {
        await registration.dispose()
      } finally {
        await servers.dispose()
      }
    })())
}
