import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { type ErrorCode, OmoError } from "../errors/base.js"

export interface LspServerConfig {
  command: string
  args?: string[]
  root: string
  env?: Record<string, string>
  initializationOptions?: unknown
  timeoutMs?: number
}
export interface Position {
  line: number
  character: number
}
export interface Diagnostic {
  message: string
  range: { start: Position; end: Position }
  severity?: number
  [key: string]: unknown
}
export class LspError extends OmoError {
  constructor(
    code: "configuration" | "timeout" | "crash" | "protocol" | "disposed" | "cancelled",
    message: string,
  ) {
    super(code, message)
  }
}

/** Windows paths must not be interpreted as URL schemes, even on POSIX. */
export function fileUri(path: string): string {
  if (/^[a-z]:[\\/]/i.test(path)) {
    const normalized = path.replaceAll("\\", "/")
    const drive = normalized.slice(0, 1).toUpperCase()
    return `file:///${drive}:${normalized.slice(2).split("/").map(encodeURIComponent).join("/")}`
  }
  if (path.startsWith("\\\\")) {
    const [host, ...segments] = path.slice(2).split("\\")
    return `file://${host}/${segments.map(encodeURIComponent).join("/")}`
  }
  return pathToFileURL(resolve(path)).href
}

function normalizeFileUri(uri: string): string {
  if (!uri.startsWith("file:")) return uri
  const parsed = new URL(uri)
  const path = decodeURIComponent(parsed.pathname)
  if (/^\/[a-z]:\//i.test(path)) return fileUri(path.slice(1))
  return parsed.href
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeLocations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeLocations)
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.startsWith("file:") ? normalizeFileUri(key) : key,
        (key === "uri" || key === "targetUri") && typeof item === "string"
          ? normalizeFileUri(item)
          : normalizeLocations(item),
      ]),
    )
  return value
}

/** Offsets and characters are JavaScript UTF-16 code units, zero based. */
export function utf16Position(text: string, offset: number): Position {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length)
    throw new RangeError("Invalid UTF-16 offset")
  const prefix = text.slice(0, offset)
  const lines = prefix.split("\n")
  return { line: lines.length - 1, character: (lines.at(-1) ?? "").length }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}
interface Document {
  text: string
  version: number
  languageId: string
}
interface DiagnosticSnapshot {
  version?: number
  diagnostics: Diagnostic[]
}

export class LspHandle {
  private buffer = Buffer.alloc(0)
  private nextID = 0
  private pending = new Map<number, Pending>()
  private documents = new Map<string, Document>()
  private snapshots = new Map<string, DiagnosticSnapshot>()
  private diagnosticListeners = new Set<() => void>()
  private failure?: LspError
  private disposing?: Promise<void>
  private closed: Promise<void>
  private stderr = ""
  capabilities: Record<string, unknown> = {}
  get alive() {
    return !this.failure && this.child.exitCode === null && !this.child.killed
  }

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private config: LspServerConfig,
  ) {
    this.closed = new Promise((resolveClosed) => {
      child.once("close", (code, signal) => {
        this.fail(new LspError("crash", `LSP exited (${code ?? signal}): ${this.stderr}`))
        resolveClosed()
      })
    })
    child.once("exit", (code, signal) =>
      this.fail(new LspError("crash", `LSP exited (${code ?? signal}): ${this.stderr}`)),
    )
    child.on("error", (error) =>
      this.fail(
        new LspError(
          "configuration",
          `Cannot start LSP ${config.command}: ${error.message}. Configure an installed server; no auto-installation is performed.`,
        ),
      ),
    )
    child.stdin.on("error", (error) =>
      this.fail(new LspError("crash", `LSP stdin: ${error.message}`)),
    )
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4096)
    })
    child.stdout.on("data", (chunk) => {
      try {
        this.consume(chunk)
      } catch (error) {
        this.fail(new LspError("protocol", String(error)))
        child.kill()
      }
    })
  }

  private fail(error: LspError) {
    this.failure ??= error
    for (const entry of this.pending.values()) {
      entry.cleanup()
      entry.reject(this.failure)
    }
    this.pending.clear()
    for (const listener of this.diagnosticListeners) listener()
  }
  private send(message: unknown) {
    if (this.failure) throw this.failure
    const body = Buffer.from(JSON.stringify(message))
    this.child.stdin.write(
      Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]),
    )
  }
  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n")
      if (end < 0) {
        if (this.buffer.length > 8192) throw new Error("LSP header too large")
        return
      }
      const header = this.buffer.subarray(0, end).toString("ascii")
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header)
      if (!match) throw new Error("LSP missing Content-Length")
      const length = Number(match[1])
      if (length > 16 * 1024 * 1024) throw new Error("LSP message exceeds 16 MiB")
      if (this.buffer.length < end + 4 + length) return
      const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString("utf8"))
      this.buffer = this.buffer.subarray(end + 4 + length)
      if (message.method) {
        if (message.id !== undefined) this.answerServer(message)
        else if (message.method === "textDocument/publishDiagnostics") {
          const { version, diagnostics } = message.params
          const uri = normalizeFileUri(message.params.uri)
          if (!this.documents.has(uri)) continue
          const current = this.documents.get(uri)
          if (!current) continue
          if (version !== undefined && version < current.version) continue
          this.snapshots.set(uri, { version: version ?? current.version, diagnostics })
          for (const listener of this.diagnosticListeners) listener()
        }
      } else {
        const entry = this.pending.get(message.id)
        if (!entry) continue
        this.pending.delete(message.id)
        entry.cleanup()
        if (message.error)
          entry.reject(new LspError("protocol", `${message.error.code}: ${message.error.message}`))
        else entry.resolve(normalizeLocations(message.result))
      }
    }
  }
  private answerServer(message: { id: string | number; method: string; params?: unknown }) {
    let result: unknown = null
    if (message.method === "workspace/configuration") {
      const params = isRecord(message.params) ? message.params : undefined
      const items = params && Array.isArray(params.items) ? params.items : []
      result = items.map(() => this.config.initializationOptions ?? null)
    } else if (message.method === "workspace/workspaceFolders")
      result = [{ uri: fileUri(this.config.root), name: "omo" }]
    else if (
      ![
        "client/registerCapability",
        "client/unregisterCapability",
        "window/workDoneProgress/create",
      ].includes(message.method)
    ) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Client method not supported" },
      })
      return
    }
    this.send({ jsonrpc: "2.0", id: message.id, result })
  }
  request(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
    timeoutMs = this.config.timeoutMs ?? 10_000,
  ): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    if (signal?.aborted) return Promise.reject(new LspError("cancelled", "LSP request aborted"))
    const id = ++this.nextID
    return new Promise((resolveRequest, reject) => {
      const stop = (error: LspError) => {
        if (!this.pending.delete(id)) return
        cleanup()
        try {
          this.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } })
        } catch {
          /* process already failed */
        }
        reject(error)
      }
      const timer = setTimeout(
        () => stop(new LspError("timeout", `LSP ${method} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      const abort = () => stop(new LspError("cancelled", `LSP ${method} aborted`))
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
      }
      this.pending.set(id, { resolve: resolveRequest, reject, cleanup })
      signal?.addEventListener("abort", abort, { once: true })
      try {
        this.send({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        this.pending.delete(id)
        cleanup()
        reject(error)
      }
    })
  }
  notify(method: string, params?: unknown) {
    this.send({ jsonrpc: "2.0", method, params })
  }

  async openDocument(uri: string, languageId: string, text: string) {
    const previous = this.documents.get(uri)
    if (previous?.text === text) return
    const sync = this.capabilities.textDocumentSync
    const change = isRecord(sync) ? sync.change : undefined
    const kind = typeof sync === "number" ? sync : typeof change === "number" ? change : undefined
    if (previous && (kind === 0 || kind === undefined))
      throw new LspError(
        "protocol",
        "Server does not support document changes; close/reopen required",
      )
    const document = { languageId, text, version: (previous?.version ?? 0) + 1 }
    this.documents.set(uri, document)
    this.snapshots.delete(uri)
    if (!previous) this.notify("textDocument/didOpen", { textDocument: { uri, ...document } })
    else {
      const change =
        kind === 2
          ? {
              range: {
                start: { line: 0, character: 0 },
                end: utf16Position(previous.text, previous.text.length),
              },
              text,
            }
          : { text }
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: document.version },
        contentChanges: [change],
      })
    }
  }
  closeDocument(uri: string) {
    if (this.documents.delete(uri)) this.notify("textDocument/didClose", { textDocument: { uri } })
    this.snapshots.delete(uri)
    for (const listener of this.diagnosticListeners) listener()
  }
  private checkPosition(uri: string, position: Position) {
    const document = this.documents.get(uri)
    if (!document) throw new LspError("configuration", "Open the document before querying it")
    const lines = document.text.split("\n")
    const line = lines[position.line] ?? ""
    if (
      !Number.isInteger(position.line) ||
      !Number.isInteger(position.character) ||
      position.line < 0 ||
      position.character < 0 ||
      position.line >= lines.length ||
      position.character > line.replace(/\r$/, "").length
    )
      throw new RangeError("Position must be a valid zero-based UTF-16 position")
  }
  definition(uri: string, position: Position, signal?: AbortSignal) {
    this.checkPosition(uri, position)
    if (!this.capabilities.definitionProvider)
      throw new LspError("protocol", "Server does not provide definition")
    return this.request("textDocument/definition", { textDocument: { uri }, position }, signal)
  }
  references(uri: string, position: Position, includeDeclaration = true, signal?: AbortSignal) {
    this.checkPosition(uri, position)
    if (!this.capabilities.referencesProvider)
      throw new LspError("protocol", "Server does not provide references")
    return this.request(
      "textDocument/references",
      { textDocument: { uri }, position, context: { includeDeclaration } },
      signal,
    )
  }
  workspaceSymbols(query: string, signal?: AbortSignal) {
    if (typeof query !== "string" || query.length > 4096 || query.includes("\0"))
      throw new LspError("configuration", "Workspace symbol query must be a bounded string")
    if (!this.capabilities.workspaceSymbolProvider)
      throw new LspError("protocol", "Server does not provide workspace symbols")
    return this.request("workspace/symbol", { query }, signal)
  }
  symbols(uri: string, signal?: AbortSignal) {
    if (!this.documents.has(uri))
      throw new LspError("configuration", "Open document before requesting symbols")
    if (!this.capabilities.documentSymbolProvider)
      throw new LspError("protocol", "Server does not provide document symbols")
    return this.request("textDocument/documentSymbol", { textDocument: { uri } }, signal)
  }
  prepareRename(uri: string, position: Position, signal?: AbortSignal) {
    this.checkPosition(uri, position)
    const provider = this.capabilities.renameProvider
    if (!isRecord(provider) || !provider.prepareProvider)
      throw new LspError("protocol", "Server does not provide prepareRename")
    return this.request("textDocument/prepareRename", { textDocument: { uri }, position }, signal)
  }
  /** Returns a WorkspaceEdit proposal. Never writes or executes server-provided changes. */
  rename(uri: string, position: Position, newName: string, signal?: AbortSignal) {
    this.checkPosition(uri, position)
    if (!newName.trim() || /[\r\n\0]/.test(newName))
      throw new LspError("configuration", "newName must be nonempty and single-line")
    if (!this.capabilities.renameProvider)
      throw new LspError("protocol", "Server does not provide rename")
    return this.request("textDocument/rename", { textDocument: { uri }, position, newName }, signal)
  }
  diagnostics(uri: string, signal?: AbortSignal): Promise<Diagnostic[]> {
    if (!this.documents.has(uri))
      return Promise.reject(
        new LspError("configuration", "Open document before requesting diagnostics"),
      )
    if (this.failure) return Promise.reject(this.failure)
    if (signal?.aborted) return Promise.reject(new LspError("cancelled", "Diagnostics aborted"))
    return new Promise((resolveDiagnostics, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        this.diagnosticListeners.delete(check)
        signal?.removeEventListener("abort", abort)
      }
      const abort = () => {
        cleanup()
        reject(new LspError("cancelled", "Diagnostics aborted"))
      }
      const check = () => {
        if (this.failure) {
          cleanup()
          reject(this.failure)
          return
        }
        const snapshot = this.snapshots.get(uri)
        if (snapshot && snapshot.version === this.documents.get(uri)?.version) {
          cleanup()
          resolveDiagnostics(snapshot.diagnostics)
        } else if (!this.documents.has(uri)) {
          cleanup()
          reject(new LspError("disposed", "Document closed"))
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new LspError("timeout", "Server did not publish diagnostics for this document version"),
        )
      }, this.config.timeoutMs ?? 10_000)
      this.diagnosticListeners.add(check)
      signal?.addEventListener("abort", abort, { once: true })
      check()
    })
  }
  dispose(): Promise<void> {
    this.disposing ??= this.shutdown()
    return this.disposing
  }
  private async shutdown() {
    if (!this.failure) {
      try {
        await this.request(
          "shutdown",
          undefined,
          undefined,
          Math.min(this.config.timeoutMs ?? 1000, 1000),
        )
        this.notify("exit")
      } catch {
        /* force-stop unresponsive owned process */
      }
    }
    this.fail(new LspError("disposed", "LSP disposed"))
    const timer = setTimeout(() => {
      this.child.kill("SIGKILL")
    }, 500)
    if (this.child.exitCode !== null) clearTimeout(timer)
    await this.closed
    clearTimeout(timer)
    this.documents.clear()
    this.snapshots.clear()
    this.diagnosticListeners.clear()
    this.buffer = Buffer.alloc(0)
    this.child.stdout.removeAllListeners()
    this.child.stderr.removeAllListeners()
    this.child.stdin.removeAllListeners()
  }
}

export async function startServer(config: LspServerConfig): Promise<LspHandle> {
  if (
    !config.command ||
    !config.root ||
    (config.timeoutMs !== undefined &&
      (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0))
  )
    throw new LspError("configuration", "LSP requires command, root, and positive timeoutMs")
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.root,
    env: { ...process.env, ...config.env },
    shell: false,
    windowsHide: true,
    stdio: "pipe",
  })
  const handle = new LspHandle(child, config)
  try {
    const result = await handle.request("initialize", {
      processId: process.pid,
      rootUri: fileUri(config.root),
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        workspace: { configuration: true },
        textDocument: {
          publishDiagnostics: { versionSupport: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: true },
        },
      },
      workspaceFolders: [{ uri: fileUri(config.root), name: "omo" }],
      initializationOptions: config.initializationOptions,
    })
    if (!isRecord(result)) throw new LspError("protocol", "Initialize returned no result")
    const capabilities = isRecord(result.capabilities) ? result.capabilities : {}
    handle.capabilities = capabilities
    const encoding = capabilities.positionEncoding
    if (encoding && encoding !== "utf-16")
      throw new LspError("protocol", "Server selected unsupported position encoding")
    handle.notify("initialized", {})
    return handle
  } catch (error) {
    await handle.dispose()
    throw error
  }
}
