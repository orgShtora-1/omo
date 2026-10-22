import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { applyWorkspaceEdit } from "../../src/lsp/apply"
import { mountLsp } from "../../src/lsp/tools"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const replacement = (start: number, end: number, newText = "renamed") => ({
  range: { start: { line: 0, character: start }, end: { line: 0, character: end } },
  newText,
})

test("native LSP apply uses edit permission and rejects foreign callers before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-native-"))
  type Tool = {
    name: string
    options: { permission: string }
    execute: (
      input: unknown,
      context: { sessionID?: string; signal: AbortSignal },
    ) => Promise<unknown>
  }
  const tools: Tool[] = []
  const ctx = {
    location: { directory: root, project: { id: "project" } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        projectID: sessionID === "self" ? "project" : "foreign",
        location: { directory: root },
      }),
    },
    tool: {
      transform: async (register: (editor: unknown) => void) => {
        register({
          namespace() {},
          get() {
            return undefined
          },
          add(tool: Tool) {
            tools.push(tool)
          },
        })
        return { async dispose() {} }
      },
    },
  } as unknown as Plugin.Context
  let dispose: (() => Promise<void>) | undefined
  try {
    dispose = await mountLsp(ctx, {
      enabled: true,
      servers: [{ id: "ts", command: "unused", extensions: [".ts"], languageId: "typescript" }],
    })
    const apply = tools.find((tool) => tool.name === "lsp_apply")
    expect(apply?.options.permission).toBe("edit")
    if (!apply) throw new Error("missing apply tool")
    const file = join(root, "a.ts")
    const uri = pathToFileURL(file).href
    await writeFile(file, "abc\n")
    const input = {
      serverID: "ts",
      edit: { changes: { [uri]: [replacement(0, 3)] } },
      expectedHashes: { [uri]: hash("abc\n") },
    }
    await expect(
      apply.execute(input, { sessionID: "foreign", signal: new AbortController().signal }),
    ).rejects.toThrow("foreign-session")
    await expect(apply.execute(input, { signal: new AbortController().signal })).rejects.toThrow(
      "native-session",
    )
    expect(await readFile(file, "utf8")).toBe("abc\n")
    expect(
      await apply.execute(input, { sessionID: "self", signal: new AbortController().signal }),
    ).toMatchObject({ output: { applied: true, files: 1 } })
    expect(await readFile(file, "utf8")).toBe("renamed\n")
  } finally {
    await dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})

test("reviewed WorkspaceEdit applies UTF16 changes across files without changing CRLF", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-apply-"))
  try {
    const a = join(root, "a.ts")
    const b = join(root, "b.ts")
    const uriA = pathToFileURL(a).href
    const uriB = pathToFileURL(b).href
    await writeFile(a, "😀abc\r\nnext\r\n")
    await writeFile(b, "abc\n")
    expect(
      await applyWorkspaceEdit(
        root,
        { changes: { [uriA]: [replacement(2, 5)], [uriB]: [replacement(0, 3)] } },
        { [uriA]: hash("😀abc\r\nnext\r\n"), [uriB]: hash("abc\n") },
        new AbortController().signal,
      ),
    ).toEqual({ applied: true, files: 2 })
    expect(await readFile(a, "utf8")).toBe("😀renamed\r\nnext\r\n")
    expect(await readFile(b, "utf8")).toBe("renamed\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each(["stale", "outside", "overlap", "surrogate", "resource", "version", "cancel"])(
  "WorkspaceEdit %s rejection preserves every target",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "omo-lsp-apply-"))
    const outside = await mkdtemp(join(tmpdir(), "omo-lsp-outside-"))
    try {
      const a = join(root, "a.ts")
      const b = join(mode === "outside" ? outside : root, "b.ts")
      const uriA = pathToFileURL(a).href
      const uriB = pathToFileURL(b).href
      await writeFile(a, "😀abc\n")
      await writeFile(b, "abc\n")
      const edits =
        mode === "overlap"
          ? [replacement(2, 4), replacement(3, 5)]
          : [replacement(mode === "surrogate" ? 1 : 2, 5)]
      const edit =
        mode === "resource"
          ? { documentChanges: [{ kind: "delete", uri: uriA }] }
          : mode === "version"
            ? { documentChanges: [{ textDocument: { uri: uriA, version: 2 }, edits }] }
            : { changes: { [uriA]: edits, [uriB]: [replacement(0, 3)] } }
      const controller = new AbortController()
      if (mode === "cancel") controller.abort()
      const expected = { [uriA]: hash("😀abc\n"), [uriB]: hash(mode === "stale" ? "old" : "abc\n") }
      const errors: Record<string, string> = {
        stale: "stale-content",
        outside: "outside-root",
        overlap: "overlapping-edits",
        surrogate: "invalid-position",
        resource: "unsupported-resource-operation",
        version: "unsupported-document-version",
        cancel: "aborted",
      }
      await expect(applyWorkspaceEdit(root, edit, expected, controller.signal)).rejects.toThrow(
        errors[mode],
      )
      expect(await readFile(a, "utf8")).toBe("😀abc\n")
      expect(await readFile(b, "utf8")).toBe("abc\n")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  },
)
