import { createHash } from "node:crypto"
import { type FileHandle, lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, relative } from "node:path"
import { fileURLToPath } from "node:url"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function offset(text: string, position: unknown): number {
  if (!record(position)) throw new Error("invalid-position")
  const { line, character } = position
  if (
    typeof line !== "number" ||
    typeof character !== "number" ||
    !Number.isSafeInteger(line) ||
    !Number.isSafeInteger(character) ||
    line < 0 ||
    character < 0
  )
    throw new Error("invalid-position")
  const lines = text.split("\n")
  const current = lines[line]
  if (current === undefined || character > current.replace(/\r$/, "").length)
    throw new Error("invalid-position")
  const before = current.charCodeAt(character - 1)
  const after = current.charCodeAt(character)
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
    throw new Error("invalid-position")
  return lines.slice(0, line).reduce((total, item) => total + item.length + 1, 0) + character
}

function transform(text: string, edits: unknown): string {
  if (!Array.isArray(edits)) throw new Error("invalid-text-edits")
  const spans = edits
    .map((edit) => {
      if (!record(edit) || !record(edit.range) || typeof edit.newText !== "string")
        throw new Error("invalid-text-edits")
      const start = offset(text, edit.range.start)
      const end = offset(text, edit.range.end)
      if (end < start) throw new Error("invalid-position")
      return { start, end, text: edit.newText }
    })
    .sort((a, b) => a.start - b.start || a.end - b.end)
  for (let index = 1; index < spans.length; index++) {
    const previous = spans[index - 1]
    const current = spans[index]
    if (previous && current && (current.start < previous.end || current.start === previous.start))
      throw new Error("overlapping-edits")
  }
  let result = text
  for (const span of spans.reverse())
    result = result.slice(0, span.start) + span.text + result.slice(span.end)
  return result
}

// Serialize applications in this process. This is not a filesystem-wide lock.
let queue: Promise<unknown> = Promise.resolve()

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024

async function writeInPlace(
  handle: FileHandle,
  bytes: Buffer,
  _path: string,
  _phase: "write" | "restore",
): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
    if (!bytesWritten) throw new Error("write-failed")
    offset += bytesWritten
  }
  await handle.truncate(bytes.length)
}

export interface ApplyOptions {
  /**
   * Test seam for the write/restore primitive. Production always uses the
   * filesystem writer; injection exists so failure paths are observable. The
   * phase tells the injector whether it replaces edited content or restores the
   * original bytes after a failure.
   */
  replace?: (
    handle: FileHandle,
    bytes: Buffer,
    path: string,
    phase: "write" | "restore",
  ) => Promise<void>
  /**
   * Test seam for the descriptor acquisition. Production always opens the
   * checked path read/write; injection exists so a descriptor that does not
   * belong to the checked path can be observed.
   */
  open?: (path: string) => Promise<FileHandle>
}

export async function applyWorkspaceEdit(
  root: string,
  edit: unknown,
  expectedHashes: Record<string, string>,
  signal: AbortSignal,
  options?: ApplyOptions,
): Promise<{ applied: true; files: number }> {
  const replace = options?.replace ?? writeInPlace
  const openFile = options?.open ?? ((path: string) => open(path, "r+"))
  const run = queue.then(() => apply(root, edit, expectedHashes, signal, replace, openFile))
  queue = run.catch(() => undefined)
  return run
}

async function apply(
  root: string,
  edit: unknown,
  hashes: Record<string, string>,
  signal: AbortSignal,
  replace: NonNullable<ApplyOptions["replace"]>,
  openFile: NonNullable<ApplyOptions["open"]>,
): Promise<{ applied: true; files: number }> {
  const check = () => {
    if (signal.aborted) throw new Error("aborted")
  }
  check()
  if (!record(edit)) throw new Error("invalid-workspace-edit")
  const documents = new Map<string, unknown>()
  if (edit.documentChanges !== undefined) {
    if (!Array.isArray(edit.documentChanges)) throw new Error("invalid-workspace-edit")
    // The spec prefers versioned document edits when both forms are present, so
    // `changes` is only consulted when `documentChanges` is absent.
    for (const document of edit.documentChanges) {
      if (!record(document) || document.kind !== undefined)
        throw new Error("unsupported-resource-operation")
      if (!record(document.textDocument) || typeof document.textDocument.uri !== "string")
        throw new Error("invalid-workspace-edit")
      if (document.textDocument.version !== null && document.textDocument.version !== undefined)
        throw new Error("unsupported-document-version")
      const uri = document.textDocument.uri
      if (documents.has(uri)) throw new Error("duplicate-document")
      documents.set(uri, document.edits)
    }
  }
  if (documents.size === 0 && edit.changes !== undefined) {
    if (!record(edit.changes)) throw new Error("invalid-workspace-edit")
    for (const [uri, edits] of Object.entries(edit.changes)) documents.set(uri, edits)
  }
  if (!documents.size || documents.size > 100) throw new Error("invalid-document-count")
  const canonicalRoot = await realpath(root)
  const files: Array<{ path: string; handle: FileHandle; before: Buffer; after: Buffer }> = []
  const paths = new Set<string>()
  let written = 0
  try {
    for (const [uri, edits] of documents) {
      check()
      const url = new URL(uri)
      if (url.protocol !== "file:" || url.search || url.hash)
        throw new Error("invalid-document-uri")
      const path = await realpath(fileURLToPath(url))
      const boundary = relative(canonicalRoot, path)
      if (
        boundary === ".." ||
        boundary.startsWith("..\\") ||
        boundary.startsWith("../") ||
        isAbsolute(boundary)
      )
        throw new Error("outside-root")
      const checked = await lstat(fileURLToPath(url))
      if (checked.isSymbolicLink()) throw new Error("symlink-document")
      if (paths.has(path)) throw new Error("duplicate-document")
      paths.add(path)
      const handle = await openFile(path)
      const file = { path, handle, before: Buffer.alloc(0), after: Buffer.alloc(0) }
      files.push(file)
      const stat = await handle.stat()
      // The path was resolved and inspected before opening, so the descriptor
      // must belong to that same file. Without this, a file replaced between the
      // check and the open would be edited while the reviewed one is untouched.
      // Platforms reporting a zero inode get the pre-existing confinement only.
      if (
        (checked.dev !== 0 || stat.dev !== 0) &&
        (stat.dev !== 0 || stat.ino !== 0) &&
        (checked.dev !== stat.dev || checked.ino !== stat.ino)
      )
        throw new Error("document-replaced")
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("unsupported-document")
      file.before = await handle.readFile()
      if (createHash("sha256").update(file.before).digest("hex") !== hashes[uri])
        throw new Error("stale-content")
      const text = file.before.toString("utf8")
      if (!Buffer.from(text).equals(file.before)) throw new Error("unsupported-encoding")
      file.after = Buffer.from(transform(text, edits))
      if (file.after.length > MAX_DOCUMENT_BYTES) throw new Error("result-too-large")
    }
    check()
    // All inputs are validated before the first write. Re-check open descriptors.
    for (const file of files) {
      const current = Buffer.alloc(file.before.length)
      const { bytesRead } = await file.handle.read(current, 0, current.length, 0)
      if (
        bytesRead !== current.length ||
        !current.equals(file.before) ||
        (await file.handle.stat()).size !== file.before.length
      )
        throw new Error("stale-content")
    }
    for (const file of files) {
      check()
      written++ // Include a partially failed write in rollback.
      await replace(file.handle, file.after, file.path, "write")
    }
    return { applied: true, files: files.length }
  } catch (error) {
    // Every restore is attempted even when an earlier one fails: abandoning the
    // loop would leave an already-written file modified forever. The original
    // failure stays the thrown error; incomplete restores are reported on it.
    const failures: string[] = []
    for (const file of files.slice(0, written).reverse()) {
      try {
        await replace(file.handle, file.before, file.path, "restore")
      } catch (restoreError) {
        failures.push(
          `${file.path}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        )
      }
    }
    if (failures.length > 0 && error instanceof Error)
      Object.assign(error, { rollbackFailures: failures })
    throw error
  } finally {
    // A failing close must never mask the outcome of the apply or the rollback.
    await Promise.all(files.map((file) => file.handle.close().catch(() => undefined)))
  }
}
