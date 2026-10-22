import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { LspError, type LspHandle, type LspServerConfig, startServer } from "./client"

export interface ConfiguredServer extends LspServerConfig {
  id: string
  extensions: string[]
  languageId: string
}
export interface LspOptions {
  enabled: boolean
  servers: ConfiguredServer[]
}

export function parseLspOptions(input: unknown, directory: string): LspOptions {
  if (input === undefined) return { enabled: false, servers: [] }
  const object = input as Record<string, unknown>
  if (!object || typeof object !== "object" || Array.isArray(object))
    throw new LspError("configuration", "lsp must be an object")
  if (object.enabled !== undefined && typeof object.enabled !== "boolean")
    throw new LspError("configuration", "lsp.enabled must be boolean")
  if (object.servers !== undefined && !Array.isArray(object.servers))
    throw new LspError("configuration", "lsp.servers must be an array")
  const seen = new Set<string>()
  const servers = ((object.servers ?? []) as unknown[]).map((value, index) => {
    const entry = value as Record<string, unknown>
    const invalid = (field: string): never => {
      throw new LspError("configuration", `lsp.servers[${index}].${field} is invalid`)
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid("server")
    const string = (key: string): string =>
      typeof entry[key] === "string" && entry[key] ? (entry[key] as string) : invalid(key)
    const id = string("id")
    if (seen.has(id)) invalid("id (duplicate)")
    seen.add(id)
    const command = string("command")
    const languageId = string("languageId")
    const extensions = entry.extensions
    if (
      !Array.isArray(extensions) ||
      !extensions.length ||
      extensions.some((item) => typeof item !== "string" || !item.startsWith("."))
    )
      invalid("extensions")
    if (
      entry.args !== undefined &&
      (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string"))
    )
      invalid("args")
    if (entry.root !== undefined && typeof entry.root !== "string") invalid("root")
    if (
      entry.timeoutMs !== undefined &&
      (typeof entry.timeoutMs !== "number" ||
        !Number.isInteger(entry.timeoutMs) ||
        entry.timeoutMs <= 0)
    )
      invalid("timeoutMs")
    if (
      entry.env !== undefined &&
      (!entry.env ||
        typeof entry.env !== "object" ||
        Array.isArray(entry.env) ||
        Object.values(entry.env).some((value) => typeof value !== "string"))
    )
      invalid("env")
    return {
      id,
      command,
      languageId,
      extensions: extensions as string[],
      root: resolve(directory, (entry.root as string) ?? "."),
      args: entry.args as string[] | undefined,
      timeoutMs: entry.timeoutMs as number | undefined,
      env: entry.env as Record<string, string> | undefined,
      initializationOptions: entry.initializationOptions,
    }
  })
  if (object.enabled && !servers.length)
    throw new LspError("configuration", "lsp.enabled requires at least one configured server")
  return { enabled: object.enabled === true, servers }
}

export class LspServers {
  private handles = new Map<string, Promise<LspHandle>>()
  private queues = new Map<string, Promise<unknown>>()
  private closed = false
  private cleanup?: Promise<void>
  constructor(readonly options: LspOptions) {}
  async document(path: string, id?: string) {
    if (this.closed) throw new LspError("disposed", "LSP module unloaded")
    const candidates = this.options.servers.filter(
      (server) =>
        (!id || server.id === id) &&
        server.extensions.some((extension) => path.endsWith(extension)),
    )
    const config = candidates.length === 1 ? candidates[0] : undefined
    if (!config)
      throw new LspError(
        "configuration",
        candidates.length
          ? "Multiple LSP servers match; supply serverID"
          : "No configured LSP server matches this file",
      )
    const root = await realpath(config.root)
    const file = await realpath(resolve(root, path))
    const difference = relative(root, file)
    if (
      difference === ".." ||
      difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(difference)
    )
      throw new LspError(
        "configuration",
        "LSP file must be inside the configured root (including symlink targets)",
      )
    return { config, file }
  }
  async use<T>(config: ConfiguredServer, action: (handle: LspHandle) => Promise<T>): Promise<T> {
    const previous = this.queues.get(config.id) ?? Promise.resolve()
    const result = previous.then(async () => {
      if (this.closed) throw new LspError("disposed", "LSP module unloaded")
      let starting = this.handles.get(config.id)
      if (!starting) {
        starting = startServer(config)
        this.handles.set(config.id, starting)
      }
      return action(await starting)
    })
    this.queues.set(
      config.id,
      result.catch(() => {}),
    )
    return result
  }
  dispose(): Promise<void> {
    this.cleanup ??= (async () => {
      this.closed = true
      const results = await Promise.allSettled(
        [...this.handles.values()].map((handle) =>
          handle.then(
            (value) => value.dispose(),
            () => {},
          ),
        ),
      )
      await Promise.allSettled(this.queues.values())
      this.handles.clear()
      this.queues.clear()
      // Failed startup already disposes its process; report cleanup errors only for live handles.
      const errors = results.filter((result) => result.status === "rejected")
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => (result as PromiseRejectedResult).reason),
          "LSP cleanup failed",
        )
    })()
    return this.cleanup
  }
}
