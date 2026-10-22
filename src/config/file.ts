import { randomUUID } from "node:crypto"
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { MCP_SERVER_IDS, type McpServerID } from "../mcp/config"
import { DEFAULT_REMOTE_URLS } from "../mcp/defaults"
import { parseJSONC } from "./jsonc"
import { validateConfiguredModels } from "./models"
import { resolveOptions } from "./resolve"
import { OptionsError, parseOptions } from "./schema"

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined
}
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (code(error) === "ENOENT") return false
    throw error
  }
}

async function discoverHostConfig(
  directory: string,
  hostConfigPath?: string,
  globalConfigDirectory = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "opencode",
  ),
): Promise<string> {
  if (hostConfigPath) {
    const path = resolve(directory, hostConfigPath)
    if (!(await isFile(path))) throw new OptionsError(path, "host configuration does not exist")
    return path
  }
  let current = resolve(directory)
  let direct: string | undefined
  while (true) {
    for (const name of ["opencode.jsonc", "opencode.json"]) {
      const path = join(current, ".opencode", name)
      if (await isFile(path)) return path
    }
    if (!direct)
      for (const name of ["opencode.jsonc", "opencode.json"]) {
        const path = join(current, name)
        if (await isFile(path)) {
          direct = path
          break
        }
      }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  if (direct) return direct
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const path = join(globalConfigDirectory, name)
    if (await isFile(path)) return path
  }
  throw new OptionsError(
    "opencode",
    "no opencode.json/jsonc found; provide hostConfigPath explicitly",
  )
}

export type LoadOmoConfigInput = {
  directory: string
  /** Directory that holds the global omo.jsonc shared by every project (see omoConfigHome). */
  configHome: string
  /** Read-only fallback consulted when the primary omo.jsonc is missing; never created, moved, or migrated. */
  legacyConfigPath?: string
  hostConfigPath?: string
  globalConfigDirectory?: string
  /** Validated plugin options override the global configuration file. */
  overrides?: Record<string, unknown>
  availableModels?: readonly import("../contracts").ModelRef[]
}

export async function loadOmoConfig(input: LoadOmoConfigInput) {
  const hostConfigPath = await discoverHostConfig(
    input.directory,
    input.hostConfigPath,
    input.globalConfigDirectory,
  )
  const path = join(input.configHome, "omo.jsonc")
  if (await isFile(path)) return finalize(path, hostConfigPath, false, input)
  if (input.legacyConfigPath && (await isFile(input.legacyConfigPath))) {
    // Upgrades: a pre-config-home omo.jsonc is honored where it lies instead of
    // being shadowed by a fresh default. Read-only: nothing is created, moved,
    // or migrated while it remains the effective configuration.
    return finalize(input.legacyConfigPath, hostConfigPath, false, input)
  }
  const temporary = join(dirname(path), `.omo-${randomUUID()}.tmp`)
  let created = false
  try {
    // The configuration home may not exist yet; the atomic publish below needs
    // its directory.
    await mkdir(input.configHome, { recursive: true })
    // Publish a fully written file with atomic no-clobber semantics, including concurrent setup.
    await writeFile(
      temporary,
      '// @shtora/omo configuration. Models inherit the host unless configured.\n{\n  "schemaVersion": 1,\n  "agents": {},\n}\n',
      { flag: "wx" },
    )
    try {
      await link(temporary, path)
      created = true
    } catch (error) {
      if (code(error) !== "EEXIST") throw error
    }
  } finally {
    try {
      await unlink(temporary)
    } catch (error) {
      if (code(error) !== "ENOENT") console.warn("omo configuration temporary-file cleanup failed")
    }
  }
  return finalize(path, hostConfigPath, created, input)
}

async function finalize(
  path: string,
  hostConfigPath: string,
  created: boolean,
  input: LoadOmoConfigInput,
) {
  const document = parseJSONC(await readFile(path, "utf8"), path)
  if (!isObject(document)) throw new OptionsError(path, "expected configuration object")
  const overrides = input.overrides ?? {}
  const raw = { ...document, ...overrides } as Record<string, unknown>
  for (const key of [
    "agents",
    "execution",
    "skills",
    "runtime",
    "teams",
    "lsp",
    "terminal",
    "telemetry",
  ]) {
    const base = (document as Record<string, unknown>)[key]
    const override = overrides[key]
    if (
      base &&
      override &&
      typeof base === "object" &&
      typeof override === "object" &&
      !Array.isArray(base) &&
      !Array.isArray(override)
    )
      raw[key] = { ...base, ...override }
  }
  if (isObject(document.mcp) && isObject(overrides.mcp))
    raw.mcp = mergeMcpConfig(document.mcp, overrides.mcp)
  const options = parseOptions(raw)
  validateConfiguredModels(options, input.availableModels)
  return { path, hostConfigPath, created, options, resolved: resolveOptions(options) }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeMcpConfig(base: Record<string, unknown>, override: Record<string, unknown>) {
  const merged = { ...base, ...override }
  if (!isObject(base.servers) || !isObject(override.servers)) return merged
  const servers = { ...base.servers, ...override.servers }
  for (const [name, patch] of Object.entries(override.servers)) {
    const original = base.servers[name]
    if (isObject(original) && isObject(patch)) servers[name] = mergeMcpServer(name, original, patch)
  }
  return { ...merged, servers }
}

function mergeMcpServer(
  name: string,
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
) {
  const inherited = { ...base }
  // Authentication maps replace atomically. A replacement endpoint cannot
  // inherit another endpoint's explicit credentials unless supplied again.
  if (isBuiltInServer(name) && endpointChanged(name, base, patch)) {
    delete inherited.headers
    delete inherited.oauth
  }
  return { ...inherited, ...patch }
}

function isBuiltInServer(name: string): name is McpServerID {
  return MCP_SERVER_IDS.includes(name as McpServerID)
}

function endpointChanged(
  name: McpServerID,
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  if (patch.url === undefined) return false
  const configured = typeof base.url === "string" ? base.url : undefined
  const builtIn = name === "skills" ? undefined : DEFAULT_REMOTE_URLS[name]
  return patch.url !== (configured ?? builtIn)
}
