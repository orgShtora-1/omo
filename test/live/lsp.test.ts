import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileUri, startServer } from "../../src/lsp/client"

// Opt-in: no installation or credentials. Missing environment is explicitly unverified.
const live = process.env.OMO_LSP_REAL === "1" ? test : test.skip
live(
  "installed TypeScript LSP returns symbols, rename proposals and diagnostics without modifying files",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "omo-real-lsp-"))
    const text =
      'export const answer: number = 42;\nconst used = answer;\nconst broken: number = "bad";\n'
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }),
    )
    await writeFile(join(root, "main.ts"), text)
    const server = await startServer({
      command: process.env.OMO_LSP_COMMAND ?? "typescript-language-server",
      args: process.env.OMO_LSP_ARGS ? JSON.parse(process.env.OMO_LSP_ARGS) : ["--stdio"],
      root,
      timeoutMs: 15_000,
      initializationOptions: {
        disableAutomaticTypingAcquisition: true,
        tsserver: { path: process.env.OMO_LSP_TSSERVER, useSyntaxServer: "never" },
      },
    })
    try {
      const uri = fileUri(join(root, "main.ts"))
      await server.openDocument(uri, "typescript", text)
      const asArray = (value: unknown, label: string): unknown[] => {
        if (!Array.isArray(value)) throw new Error(`expected array for ${label}`)
        return value
      }
      const field = (value: unknown, key: string): unknown => {
        if (typeof value !== "object" || value === null) return undefined
        return (value as Record<string, unknown>)[key]
      }
      const locations = asArray(
        await server.definition(uri, { line: 1, character: 15 }),
        "definitions",
      )
      const first = locations[0]
      expect(field(first, "uri")).toBe(uri)
      expect(field(field(first, "range"), "start")).toEqual({ line: 0, character: 13 })
      const references = asArray(
        await server.references(uri, { line: 1, character: 15 }),
        "references",
      )
      expect(references.length).toBeGreaterThanOrEqual(2)
      const symbols = asArray(await server.symbols(uri), "symbols")
      expect(symbols.some((item) => field(item, "name") === "answer")).toBe(true)
      const workspaceSymbols = asArray(await server.workspaceSymbols("answer"), "workspace symbols")
      expect(workspaceSymbols.some((item) => field(item, "name") === "answer")).toBe(true)
      const prepared = await server.prepareRename(uri, { line: 1, character: 15 })
      expect(field(prepared, "range") ?? prepared).toEqual({
        start: { line: 1, character: 13 },
        end: { line: 1, character: 19 },
      })
      const edit = await server.rename(uri, { line: 1, character: 15 }, "renamedAnswer")
      const byUri = field(edit, "changes")
      const rawChanges =
        (typeof byUri === "object" && byUri !== null
          ? (byUri as Record<string, unknown>)[uri]
          : undefined) ??
        (Array.isArray(field(edit, "documentChanges"))
          ? (field(edit, "documentChanges") as unknown[]).flatMap((item) => {
              const edits = field(item, "edits")
              return Array.isArray(edits) ? edits : []
            })
          : undefined)
      const changes = asArray(rawChanges, "rename changes")
      expect(changes.length).toBeGreaterThanOrEqual(2)
      expect(changes.every((item) => field(item, "newText") === "renamedAnswer")).toBe(true)
      expect(await readFile(join(root, "main.ts"), "utf8")).toBe(text)
      const deadline = Date.now() + 15_000
      let diagnostics = await server.diagnostics(uri)
      while (!diagnostics.some((item) => item.code === 2322) && Date.now() < deadline) {
        await Bun.sleep(100)
        diagnostics = await server.diagnostics(uri)
      }
      expect(diagnostics.some((item) => item.code === 2322 && item.range.start.line === 2)).toBe(
        true,
      )
    } finally {
      await server.dispose()
      await rm(root, { recursive: true, force: true })
    }
    expect(server.alive).toBe(false)
  },
  40_000,
)
