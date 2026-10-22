import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { applyWorkspaceEdit } from "../../src/lsp/apply"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")

test("a document replaced by an identical copy between check and open is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-swap-"))
  try {
    const target = join(root, "a.ts")
    const decoy = join(root, "decoy.ts")
    await writeFile(target, "abc\n")
    // Byte-identical so only the descriptor identity can reveal the swap: the
    // content hash check alone cannot see it.
    await copyFile(target, decoy)
    const uri = pathToFileURL(target).href
    const edit = {
      changes: {
        [uri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: "renamed",
          },
        ],
      },
    }
    await expect(
      applyWorkspaceEdit(root, edit, { [uri]: hash("abc\n") }, new AbortController().signal, {
        open: () => import("node:fs/promises").then((fs) => fs.open(decoy, "r+")),
      }),
    ).rejects.toThrow("document-replaced")
    expect(await readFile(target, "utf8")).toBe("abc\n")
    expect(await readFile(decoy, "utf8")).toBe("abc\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the normal path still applies when the descriptor matches the checked path", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-swap-"))
  try {
    const target = join(root, "a.ts")
    await writeFile(target, "abc\n")
    const uri = pathToFileURL(target).href
    const opened: string[] = []
    const result = await applyWorkspaceEdit(
      root,
      {
        changes: {
          [uri]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: "renamed",
            },
          ],
        },
      },
      { [uri]: hash("abc\n") },
      new AbortController().signal,
      {
        open: (path) =>
          import("node:fs/promises")
            .then((fs) => fs.open(path, "r+"))
            .then((handle) => {
              opened.push(path)
              return handle
            }),
      },
    )
    expect(result).toEqual({ applied: true, files: 1 })
    // The store opens the resolved path, which on Windows may differ from the
    // literal temporary path by a short-name alias.
    expect(opened).toEqual([await realpath(target)])
    expect(await readFile(target, "utf8")).toBe("renamed\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
