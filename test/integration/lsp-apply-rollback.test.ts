import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { FileHandle } from "node:fs/promises"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { applyWorkspaceEdit } from "../../src/lsp/apply"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const replacement = (start: number, end: number, newText = "renamed") => ({
  range: { start: { line: 0, character: start }, end: { line: 0, character: end } },
  newText,
})

/** Two documents whose contents are known; the caller decides what each write does. */
async function pair() {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-rollback-"))
  const a = join(root, "a.ts")
  const b = join(root, "b.ts")
  await writeFile(a, "abc\n")
  await writeFile(b, "abc\n")
  const uriA = pathToFileURL(a).href
  const uriB = pathToFileURL(b).href
  const edit = { changes: { [uriA]: [replacement(0, 3)], [uriB]: [replacement(0, 3)] } }
  const hashes = { [uriA]: hash("abc\n"), [uriB]: hash("abc\n") }
  return {
    root,
    a,
    b,
    edit,
    hashes,
    signal: new AbortController().signal,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

type Replace = NonNullable<Parameters<typeof applyWorkspaceEdit>[4]>["replace"]

/** Fails `target` on the forward write, and on the restore only when asked. */
function failing(
  target: "a.ts" | "b.ts",
  message: string,
  partial: boolean,
  restoreFails = true,
): Replace {
  return async (handle, bytes, path, phase) => {
    if (path.endsWith(target)) {
      if (phase === "restore" && !restoreFails) return writeInTest(handle, bytes)
      if (partial) await handle.write(bytes.subarray(0, 1), 0, 1, 0)
      throw new Error(message)
    }
    await writeInTest(handle, bytes)
  }
}

async function writeInTest(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
    if (!bytesWritten) throw new Error("write-failed")
    offset += bytesWritten
  }
  await handle.truncate(bytes.length)
}

test("a restore that fails never leaves an earlier file modified", async () => {
  const { root, a, b, edit, hashes, signal, cleanup } = await pair()
  try {
    const failure = await applyWorkspaceEdit(root, edit, hashes, signal, {
      replace: failing("b.ts", "restore-failed", true),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const error = failure as Error & { rollbackFailures?: string[] }
    expect(error.message).toBe("restore-failed")
    expect(error.rollbackFailures?.length ?? 0).toBeGreaterThan(0)
    expect(await readFile(a, "utf8")).toBe("abc\n")
    expect(await readFile(b, "utf8")).toBe("abc\n")
  } finally {
    await cleanup()
  }
})

test("every attempted write is restored when the restore itself succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-rollback-"))
  try {
    const a = join(root, "a.ts")
    const b = join(root, "b.ts")
    await writeFile(a, "abc\n")
    await writeFile(b, "abc\n")
    const uriA = pathToFileURL(a).href
    const uriB = pathToFileURL(b).href
    const edit = { changes: { [uriA]: [replacement(0, 3)], [uriB]: [replacement(0, 3)] } }
    const hashes = { [uriA]: hash("abc\n"), [uriB]: hash("abc\n") }
    const failure = await applyWorkspaceEdit(root, edit, hashes, new AbortController().signal, {
      replace: failing("b.ts", "write-failed", false, false),
    }).catch((error: unknown) => error)
    expect((failure as Error).message).toBe("write-failed")
    expect((failure as Error & { rollbackFailures?: string[] }).rollbackFailures).toBeUndefined()
    expect(await readFile(a, "utf8")).toBe("abc\n")
    expect(await readFile(b, "utf8")).toBe("abc\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a successful rollback still reports the original failure, not the restore path", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-rollback-"))
  try {
    const a = join(root, "a.ts")
    await writeFile(a, "abc\n")
    const uriA = pathToFileURL(a).href
    const failure = await applyWorkspaceEdit(
      root,
      { changes: { [uriA]: [replacement(0, 3)] } },
      { [uriA]: hash("abc\n") },
      new AbortController().signal,
      { replace: failing("a.ts", "write-failed", false) },
    ).catch((error: unknown) => error)
    expect((failure as Error).message).toBe("write-failed")
    expect(await readFile(a, "utf8")).toBe("abc\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a result larger than the document budget is refused before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-rollback-"))
  try {
    const a = join(root, "a.ts")
    await writeFile(a, "abc\n")
    const uriA = pathToFileURL(a).href
    await expect(
      applyWorkspaceEdit(
        root,
        { changes: { [uriA]: [replacement(0, 3, "x".repeat(4 * 1024 * 1024 + 1))] } },
        { [uriA]: hash("abc\n") },
        new AbortController().signal,
      ),
    ).rejects.toThrow("result-too-large")
    expect(await readFile(a, "utf8")).toBe("abc\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("documentChanges takes precedence over changes for the same document", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-rollback-"))
  try {
    const a = join(root, "a.ts")
    await writeFile(a, "abc\n")
    const uriA = pathToFileURL(a).href
    await expect(
      applyWorkspaceEdit(
        root,
        {
          changes: { [uriA]: [replacement(0, 3, "from-changes")] },
          documentChanges: [
            {
              textDocument: { uri: uriA, version: null },
              edits: [replacement(0, 3, "from-versioned")],
            },
          ],
        },
        { [uriA]: hash("abc\n") },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ applied: true, files: 1 })
    expect(await readFile(a, "utf8")).toBe("from-versioned\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the same document twice inside documentChanges is still refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-lsp-rollback-"))
  try {
    const a = join(root, "a.ts")
    await writeFile(a, "abc\n")
    const uriA = pathToFileURL(a).href
    await expect(
      applyWorkspaceEdit(
        root,
        {
          documentChanges: [
            { textDocument: { uri: uriA, version: null }, edits: [replacement(0, 3)] },
            { textDocument: { uri: uriA, version: null }, edits: [replacement(0, 3)] },
          ],
        },
        { [uriA]: hash("abc\n") },
        new AbortController().signal,
      ),
    ).rejects.toThrow("duplicate-document")
    expect(await readFile(a, "utf8")).toBe("abc\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
