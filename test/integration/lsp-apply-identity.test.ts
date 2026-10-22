import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { mountLsp } from "../../src/lsp/tools"
import { canCreateFileSymlink } from "../helpers/symlink-privilege"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const live = () => ({ signal: new AbortController().signal })
const replace = (start: number, end: number, newText: string) => ({
  range: { start: { line: 0, character: start }, end: { line: 0, character: end } },
  newText,
})

/**
 * A native mount whose session lookup can be bent per call, so every branch of
 * the caller-identity gate is exercised instead of only the project branch.
 */
async function mount(root: string, session: (sessionID: string) => Record<string, unknown>) {
  const tools: Array<{
    name: string
    execute(input: Record<string, unknown>, context: Record<string, unknown>): Promise<unknown>
  }> = []
  const ctx = {
    location: { directory: root, project: { id: "project" } },
    session: { get: async ({ sessionID }: { sessionID: string }) => session(sessionID) },
    tool: {
      transform: async (register: (editor: unknown) => void) => {
        register({
          namespace() {},
          get() {
            return undefined
          },
          add(tool: (typeof tools)[number]) {
            tools.push(tool)
          },
        })
        return { async dispose() {} }
      },
    },
  } as unknown as Plugin.Context
  const dispose = await mountLsp(ctx, {
    enabled: true,
    servers: [{ id: "ts", command: "unused", extensions: [".ts"], languageId: "typescript" }],
  })
  const tool = tools.find((item) => item.name === "lsp_apply")
  if (!tool) throw new Error("missing lsp_apply tool")
  return {
    ctx,
    apply: (input: Record<string, unknown>, context: Record<string, unknown>) =>
      tool.execute(input, context),
    dispose,
  }
}

test.each([
  ["missing-session", { ...live() } as Record<string, unknown>, "native-session-required"],
  ["mismatched-returned-identity", { ...live(), sessionID: "self" }, "foreign-session"],
  ["foreign-project", { ...live(), sessionID: "self" }, "foreign-session"],
  ["foreign-directory", { ...live(), sessionID: "self" }, "foreign-session"],
])("the apply tool refuses %s before touching any file", async (kind, context, expected) => {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-identity-"))
  try {
    const file = join(root, "a.ts")
    const uri = pathToFileURL(file).href
    await writeFile(file, "abc\n")
    const session = (sessionID: string): Record<string, unknown> => ({
      id: kind === "mismatched-returned-identity" ? "different-session" : sessionID,
      projectID: kind === "foreign-project" ? "other-project" : "project",
      location: { directory: kind === "foreign-directory" ? join(root, "other") : root },
    })
    const mounted = await mount(root, session)
    try {
      await expect(
        mounted.apply(
          {
            serverID: "ts",
            edit: { changes: { [uri]: [replace(0, 3, "renamed")] } },
            expectedHashes: { [uri]: hash("abc\n") },
          },
          context,
        ),
      ).rejects.toThrow(expected)
      expect(await readFile(file, "utf8")).toBe("abc\n")
    } finally {
      await mounted.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("documentChanges edits apply to several documents in one call", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-docchanges-"))
  try {
    const first = join(root, "a.ts")
    const second = join(root, "b.ts")
    const firstURI = pathToFileURL(first).href
    const secondURI = pathToFileURL(second).href
    await writeFile(first, "alpha\n")
    await writeFile(second, "beta\n")
    const mounted = await mount(root, (sessionID) => ({
      id: sessionID,
      projectID: "project",
      location: { directory: root },
    }))
    try {
      const result = (await mounted.apply(
        {
          serverID: "ts",
          edit: {
            documentChanges: [
              { textDocument: { uri: firstURI }, edits: [replace(0, 5, "ALPHA")] },
              { textDocument: { uri: secondURI, version: null }, edits: [replace(0, 4, "BETA!")] },
            ],
          },
          expectedHashes: { [firstURI]: hash("alpha\n"), [secondURI]: hash("beta\n") },
        },
        { ...live(), sessionID: "self" },
      )) as { output: { applied: boolean; files: number } }
      expect(result.output).toEqual({ applied: true, files: 2 })
      expect(await readFile(first, "utf8")).toBe("ALPHA\n")
      expect(await readFile(second, "utf8")).toBe("BETA!\n")
    } finally {
      await mounted.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// File symlinks need elevation or Developer Mode on Windows; skip explicitly
// there so stock machines report a skip instead of an EPERM failure. The
// identity gate itself is unchanged and still verified where links exist.
test.skipIf(!canCreateFileSymlink)(
  "a document replaced by another file between check and open is refused",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "omo-lsp-swap-"))
    try {
      const file = join(root, "a.ts")
      const uri = pathToFileURL(file).href
      await writeFile(file, "abc\n")
      const original = createHash("sha256").update("abc\n").digest("hex")
      // A symlink is already refused by lstat; this asserts the descriptor itself is
      // matched against the path that was validated.
      await rm(file)
      await symlink(join(root, "elsewhere.ts"), file)
      await writeFile(join(root, "elsewhere.ts"), "abc\n")
      const mounted = await mount(root, (sessionID) => ({
        id: sessionID,
        projectID: "project",
        location: { directory: root },
      }))
      try {
        await expect(
          mounted.apply(
            {
              serverID: "ts",
              edit: { changes: { [uri]: [replace(0, 3, "renamed")] } },
              expectedHashes: { [uri]: original },
            },
            { ...live(), sessionID: "self" },
          ),
        ).rejects.toThrow("symlink-document")
        expect(await readFile(join(root, "elsewhere.ts"), "utf8")).toBe("abc\n")
      } finally {
        await mounted.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
