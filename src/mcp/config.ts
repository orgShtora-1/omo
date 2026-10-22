import type { Mcp } from "@opencode/plugin"

export const MCP_SERVER_IDS = ["skills", "github", "context7", "vercel", "cloudflare"] as const
export type McpServerID = (typeof MCP_SERVER_IDS)[number]

// Built-in transports are fixed: skills is local; the other presets are remote.
// Only options supported by the pinned public host SDK are accepted.
type McpServerOptions = Partial<Omit<Mcp.LocalConfig, "type"> & Omit<Mcp.RemoteConfig, "type">>
export type McpOptions = {
  enabled?: boolean
  servers?: Partial<Record<McpServerID, McpServerOptions>>
}
export type ResolvedMcpOptions = {
  enabled: boolean
  servers: Record<McpServerID, McpServerOptions & { disabled: boolean }>
}

type Fail = (path: string, message: string) => never
type OptionFragment = Record<string, unknown>

const PROTOCOLS: readonly Mcp.ServerConfig["protocol"][] = ["auto", "legacy", "2026-07-28"]
const ENVIRONMENT_REFERENCE = /\{env:[A-Za-z_][A-Za-z0-9_]*\}/

function record(candidate: unknown, path: string, fail: Fail): Record<string, unknown> {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
    return fail(path, "esperava objeto")
  return candidate as Record<string, unknown>
}

function knownKeys(
  candidate: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  fail: Fail,
): void {
  for (const key of Object.keys(candidate))
    if (!keys.includes(key)) fail(`${path}.${key}`, "campo desconhecido")
}

function text(candidate: unknown, path: string, fail: Fail): string {
  if (typeof candidate !== "string" || !candidate.trim())
    return fail(path, "esperava string não vazia")
  return candidate
}

function positiveInt(candidate: unknown, path: string, fail: Fail): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0)
    return fail(path, "esperava inteiro positivo")
  return candidate as number
}

function stringMap(candidate: unknown, path: string, fail: Fail): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(candidate, path, fail)).map(([key, entry]) => {
      if (typeof entry !== "string") fail(`${path}.${key}`, "esperava string")
      return [key, entry as string]
    }),
  )
}

function parseFlags(input: Record<string, unknown>, path: string, fail: Fail): OptionFragment {
  const parsed: OptionFragment = {}
  for (const key of ["disabled", "codemode"] as const) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== "boolean") fail(`${path}.${key}`, "esperava boolean")
    parsed[key] = input[key]
  }
  return parsed
}

function parseProtocol(candidate: unknown, path: string, fail: Fail): OptionFragment {
  if (candidate === undefined) return {}
  if (
    typeof candidate !== "string" ||
    !PROTOCOLS.includes(candidate as Mcp.ServerConfig["protocol"])
  )
    return fail(`${path}.protocol`, "protocolo MCP não suportado")
  return { protocol: candidate }
}

function parseRemoteUrl(candidate: string, path: string, fail: Fail): string {
  if (ENVIRONMENT_REFERENCE.test(candidate)) return candidate
  try {
    if (["http:", "https:"].includes(new URL(candidate).protocol)) return candidate
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
  }
  return fail(`${path}.url`, "esperava URL HTTP(S)")
}

function parseCommand(candidate: unknown, path: string, fail: Fail): string[] {
  if (!Array.isArray(candidate) || !candidate.length) return fail(path, "esperava array não vazio")
  return candidate.map((part, index) => text(part, `${path}[${index}]`, fail))
}

function parseLocal(input: Record<string, unknown>, path: string, fail: Fail): OptionFragment {
  const parsed: OptionFragment = {}
  if (input.command !== undefined)
    parsed.command = parseCommand(input.command, `${path}.command`, fail)
  if (input.cwd !== undefined) parsed.cwd = text(input.cwd, `${path}.cwd`, fail)
  if (input.environment !== undefined)
    parsed.environment = stringMap(input.environment, `${path}.environment`, fail)
  return parsed
}

function parseOAuth(candidate: unknown, path: string, fail: Fail): OptionFragment {
  if (candidate === undefined) return {}
  if (candidate === false) return { oauth: false }
  const input = record(candidate, path, fail)
  knownKeys(
    input,
    [
      "client_id",
      "client_secret",
      "scope",
      "callback_port",
      "redirect_uri",
      "auth_server_metadata_url",
    ],
    path,
    fail,
  )
  const oauth = Object.fromEntries(
    Object.entries(input).map(([key, entry]) => {
      if (key !== "callback_port") return [key, text(entry, `${path}.${key}`, fail)]
      const port = positiveInt(entry, `${path}.${key}`, fail)
      if (port > 65535) fail(`${path}.${key}`, "porta inválida")
      return [key, port]
    }),
  )
  return { oauth }
}

function parseRemote(input: Record<string, unknown>, path: string, fail: Fail): OptionFragment {
  const parsed: OptionFragment = { ...parseOAuth(input.oauth, `${path}.oauth`, fail) }
  if (input.url !== undefined)
    parsed.url = parseRemoteUrl(text(input.url, `${path}.url`, fail), path, fail)
  if (input.headers !== undefined)
    parsed.headers = stringMap(input.headers, `${path}.headers`, fail)
  return parsed
}

function parseTimeout(candidate: unknown, path: string, fail: Fail): OptionFragment {
  if (candidate === undefined) return {}
  const input = record(candidate, path, fail)
  knownKeys(input, ["startup", "catalog", "execution"], path, fail)
  const timeout = Object.fromEntries(
    Object.entries(input).map(([key, entry]) => [key, positiveInt(entry, `${path}.${key}`, fail)]),
  )
  return { timeout }
}

function parseServer(
  candidate: unknown,
  id: McpServerID,
  path: string,
  fail: Fail,
): McpServerOptions {
  const input = record(candidate, path, fail)
  const transportKeys =
    id === "skills" ? ["command", "cwd", "environment"] : ["url", "headers", "oauth"]
  knownKeys(input, ["disabled", "codemode", "protocol", "timeout", ...transportKeys], path, fail)
  const transport = id === "skills" ? parseLocal(input, path, fail) : parseRemote(input, path, fail)
  return {
    ...parseFlags(input, path, fail),
    ...parseProtocol(input.protocol, path, fail),
    ...parseTimeout(input.timeout, `${path}.timeout`, fail),
    ...transport,
  } as McpServerOptions
}

export function parseMcpOptions(candidate: unknown, fail: Fail): McpOptions {
  if (candidate === undefined) return {}
  const input = record(candidate, "mcp", fail)
  knownKeys(input, ["enabled", "servers"], "mcp", fail)
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    fail("mcp.enabled", "esperava boolean")
  let servers: McpOptions["servers"]
  if (input.servers !== undefined) {
    const entries = record(input.servers, "mcp.servers", fail)
    knownKeys(entries, MCP_SERVER_IDS, "mcp.servers", fail)
    servers = Object.fromEntries(
      Object.entries(entries).map(([id, entry]) => [
        id,
        parseServer(entry, id as McpServerID, `mcp.servers.${id}`, fail),
      ]),
    )
  }
  return {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled as boolean }),
    ...(servers ? { servers } : {}),
  }
}

export function resolveMcpOptions(options: McpOptions): ResolvedMcpOptions {
  return {
    enabled: options.enabled ?? true,
    servers: {
      skills: { disabled: false, ...options.servers?.skills },
      github: { disabled: false, ...options.servers?.github },
      context7: { disabled: false, ...options.servers?.context7 },
      vercel: { disabled: true, ...options.servers?.vercel },
      cloudflare: { disabled: true, ...options.servers?.cloudflare },
    },
  }
}
