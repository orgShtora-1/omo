import { expect, test } from "bun:test"
import { readFile, realpath } from "node:fs/promises"
import { resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { fileUri, startServer, utf16Position } from "../../src/lsp/client"
import { LspServers, parseLspOptions } from "../../src/lsp/servers"
import { mountLsp } from "../../src/lsp/tools"

interface FakeLspTool {
  name: string
  execute: (
    input: Record<string, unknown>,
    context: { signal: AbortSignal },
  ) => Promise<{ output: unknown }>
}

interface FakeToolEditor {
  namespace: () => void
  get: () => undefined
  add: (tool: FakeLspTool) => void
}

function first<T>(items: readonly T[], what: string): T {
  const head = items[0]
  if (head === undefined) throw new Error(`expected ${what}`)
  return head
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`expected ${what} to be an object`)
  return value as Record<string, unknown>
}

test("LSP handshake synchronizes documents and returns UTF16 locations and versioned diagnostics", async () => {
  expect(fileUri("C:\\Project Space\\a#b.ts")).toBe("file:///C:/Project%20Space/a%23b.ts")
  expect(utf16Position("😀abc\nnext", 2)).toEqual({ line: 0, character: 2 })
  const server = await startServer({
    command: process.execPath,
    args: [resolve("test/fixtures/lsp-server.ts")],
    root: process.cwd(),
    timeoutMs: 1500,
  })
  try {
    const uri = fileUri(resolve("fixture.ts"))
    await server.openDocument(uri, "typescript", "😀abc")
    expect((await server.diagnostics(uri))[0]?.message).toBe("fixture diagnostic")
    expect(await server.definition(uri, { line: 0, character: 2 })).toEqual([
      { uri, range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } } },
    ])
    expect(await server.references(uri, { line: 0, character: 2 })).toHaveLength(1)
    expect(await server.symbols(uri)).toEqual([{ name: "fixture", kind: 13 }])
    expect(await server.workspaceSymbols("fixture")).toEqual([{ name: "fixture", kind: 13 }])
    server.capabilities.workspaceSymbolProvider = false
    expect(() => server.workspaceSymbols("fixture")).toThrow("workspace symbols")
    expect(await server.prepareRename(uri, { line: 0, character: 2 })).toEqual({
      range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } },
      placeholder: "abc",
    })
    expect(await server.rename(uri, { line: 0, character: 2 }, "renamed")).toEqual({
      changes: {
        [uri]: [
          {
            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } },
            newText: "renamed",
          },
        ],
      },
    })
    expect(() => server.rename(uri, { line: 0, character: 2 }, "")).toThrow("newName")
    server.capabilities.renameProvider = true
    expect(() => server.prepareRename(uri, { line: 0, character: 2 })).toThrow("prepareRename")
    await server.openDocument(uri, "typescript", "fixed")
    expect(await server.diagnostics(uri)).toEqual([])
  } finally {
    await server.dispose()
    await server.dispose()
  }
  expect(server.alive).toBe(false)
})

test("timeout and abort reject requests; crash rejects pending work; missing server is actionable", async () => {
  const server = await startServer({
    command: process.execPath,
    args: [resolve("test/fixtures/lsp-server.ts")],
    root: process.cwd(),
    timeoutMs: 1000,
  })
  try {
    await expect(server.request("fixture/hang", {}, undefined, 20)).rejects.toMatchObject({
      code: "timeout",
    })
    const controller = new AbortController()
    const pending = server.request("fixture/hang", {}, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "cancelled" })
    await expect(server.request("fixture/crash")).rejects.toMatchObject({ code: "crash" })
  } finally {
    await server.dispose()
  }
  await expect(
    startServer({ command: "omo-missing-lsp-server-6e511", root: process.cwd(), timeoutMs: 50 }),
  ).rejects.toMatchObject({ code: "configuration" })
})

test("optional LSP tools load configured server lazily, expose results, and unload/reload cleanly", async () => {
  let definitions: FakeLspTool[] = []
  let disposals = 0
  const ctx = {
    location: { directory: process.cwd() },
    tool: {
      transform: async (callback: (editor: FakeToolEditor) => void) => {
        callback({
          namespace: () => {},
          get: () => undefined,
          add: (tool: FakeLspTool) => definitions.push(tool),
        })
        return {
          dispose: async () => {
            definitions = []
            disposals++
          },
        }
      },
    },
  } as unknown as Plugin.Context
  const options = {
    enabled: true,
    servers: [
      {
        id: "fixture",
        command: process.execPath,
        args: [resolve("test/fixtures/lsp-server.ts")],
        languageId: "typescript",
        extensions: [".ts"],
        timeoutMs: 1500,
      },
    ],
  }
  const cleanup = await mountLsp(ctx, options)
  expect(definitions.map((tool) => tool.name)).toEqual([
    "lsp_diagnostics",
    "lsp_definition",
    "lsp_references",
    "lsp_symbols",
    "lsp_workspace_symbols",
    "lsp_prepare_rename",
    "lsp_rename",
    "lsp_apply",
  ])
  const result = await first(definitions, "lsp diagnostics tool").execute(
    { file: "test/fixtures/lsp-server.ts" },
    { signal: new AbortController().signal },
  )
  const diagnostics = result.output
  if (!Array.isArray(diagnostics)) throw new Error("diagnostics output is not a list")
  expect(asRecord(first(diagnostics, "fixture diagnostic"), "fixture diagnostic").message).toBe(
    "fixture diagnostic",
  )
  const file = "test/fixtures/lsp-server.ts"
  const before = await readFile(file, "utf8")
  const rename = definitions.find((tool) => tool.name === "lsp_rename")
  if (!rename) throw new Error("lsp_rename tool was not registered")
  const proposal = await rename.execute(
    { file, line: 0, character: 2, newName: "renamed" },
    { signal: new AbortController().signal },
  )
  const output = asRecord(proposal.output, "rename proposal")
  expect(output.applied).toBe(false)
  const changes = asRecord(asRecord(output.edit, "rename edit").changes, "rename changes")
  // The tool opens the realpath-canonical document, so the returned change key
  // is canonical too: resolve it the same way instead of inheriting cwd casing
  // (Windows paths are case-insensitive; the cwd spelling may differ).
  const fileEdits = changes[fileUri(await realpath(resolve(file)))]
  if (!Array.isArray(fileEdits)) throw new Error("rename changes are missing the fixture file")
  expect(asRecord(first(fileEdits, "rename edit"), "rename edit").newText).toBe("renamed")
  expect(await readFile(file, "utf8")).toBe(before)
  await cleanup()
  await cleanup()
  expect(disposals).toBe(1)
  const next = await mountLsp(ctx, options)
  expect(definitions).toHaveLength(8)
  await next()
  expect(disposals).toBe(2)
  await expect(mountLsp(ctx, { enabled: true })).rejects.toMatchObject({ code: "configuration" })
})

test("server roots reject traversal and invalid configuration before starting a process", async () => {
  expect(() =>
    parseLspOptions(
      {
        enabled: true,
        servers: [{ id: "a", command: "x", languageId: "ts", extensions: [".ts"], timeoutMs: -1 }],
      },
      process.cwd(),
    ),
  ).toThrow("timeoutMs")
  const servers = new LspServers(
    parseLspOptions(
      {
        enabled: true,
        servers: [{ id: "a", command: "x", languageId: "ts", extensions: [".ts"], root: "src" }],
      },
      process.cwd(),
    ),
  )
  await expect(servers.document("../test/fixtures/lsp-server.ts")).rejects.toMatchObject({
    code: "configuration",
  })
  await servers.dispose()
})
