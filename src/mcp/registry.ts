import { existsSync } from "node:fs"
import type { Mcp, Plugin } from "@opencode/plugin"
import { loadConfigEnvironment } from "../config/environment"
import { isPinnedSkillsCommand, skillsMcpCommand } from "../config/runtime"
import type { PackageManager } from "../config/schema"
import { MCP_SERVER_IDS, type McpServerID, type ResolvedMcpOptions } from "./config"
import { DEFAULT_REMOTE_URLS } from "./defaults"

type Environment = NodeJS.ProcessEnv
type McpEditor = Parameters<Parameters<Plugin.Context["mcp"]["transform"]>[0]>[0]

export type McpProblem = {
  readonly name: McpServerID
  readonly missingEnvironment: readonly string[]
}

/** What the doctor may observe about the skills MCP entry: facts, never secrets. */
export type SkillsContribution =
  | { readonly origin: "absent" }
  | { readonly origin: "host" }
  | {
      readonly origin: "omo"
      readonly command: readonly string[]
      readonly pinned: boolean
      readonly mutationsEnabled: boolean
      readonly projectRootConfigured: boolean
    }

type PresetRequest = {
  readonly name: McpServerID
  readonly options: ResolvedMcpOptions
  readonly packageManager: PackageManager
  readonly environment: Environment
  readonly projectRoot: string | undefined
}

type ResolvedPreset = {
  readonly name: McpServerID
  readonly config: Mcp.ServerConfig
  readonly missing: readonly string[]
}

function githubDefaults(environment: Environment): Mcp.ServerConfig {
  if (!environment.GITHUB_API_KEY) return { type: "remote", url: DEFAULT_REMOTE_URLS.github }
  return {
    type: "remote",
    url: DEFAULT_REMOTE_URLS.github,
    oauth: false,
    headers: { Authorization: `Bearer ${environment.GITHUB_API_KEY}` },
  }
}

function context7Defaults(environment: Environment): Mcp.ServerConfig {
  const token = environment.CONTEXT7_API_KEY
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  return {
    type: "remote",
    url: DEFAULT_REMOTE_URLS.context7,
    oauth: false,
    ...(headers ? { headers } : {}),
  }
}

function remoteDefaults(
  name: Exclude<McpServerID, "skills">,
  environment: Environment,
): Mcp.ServerConfig {
  // Without a PAT, authentication remains host-owned; registration is not sign-in.
  if (name === "github") return githubDefaults(environment)
  if (name === "context7") return context7Defaults(environment)
  return { type: "remote", url: DEFAULT_REMOTE_URLS[name] }
}

/**
 * The skills preset always pins mutations off and, when the project directory
 * exists, scopes the local-management tools to that directory. User
 * `environment` entries merge per key, so an explicit mapping wins without
 * discarding the safe defaults.
 */
function skillsPreset(request: PresetRequest): Mcp.ServerConfig {
  const override = request.options.servers.skills
  return {
    type: "local",
    command: skillsMcpCommand(request.packageManager),
    ...override,
    environment: {
      SKILLS_ALLOW_MUTATIONS: "false",
      ...(request.projectRoot ? { SKILLS_PROJECT_ROOT: request.projectRoot } : {}),
      ...override.environment,
    },
  }
}

function preset(request: PresetRequest): Mcp.ServerConfig {
  const override = request.options.servers[request.name]
  if (request.name === "skills") return skillsPreset(request)
  const remote = request.name
  if (
    usesReplacementEndpoint(override.url, remote) ||
    override.headers !== undefined ||
    override.oauth !== undefined
  )
    return {
      type: "remote",
      url: DEFAULT_REMOTE_URLS[remote],
      ...(remote === "context7" ? { oauth: false } : {}),
      ...override,
    } as Mcp.RemoteConfig
  return { ...remoteDefaults(remote, request.environment), ...override }
}

function usesReplacementEndpoint(
  overrideUrl: string | undefined,
  name: Exclude<McpServerID, "skills">,
): boolean {
  return overrideUrl !== undefined && overrideUrl !== DEFAULT_REMOTE_URLS[name]
}

function substituteString(entry: string, environment: Environment, missing: Set<string>): string {
  return entry.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const content = environment[name]
    if (!content) missing.add(name)
    return content ?? ""
  })
}

function substituteEntry(entry: unknown, environment: Environment, missing: Set<string>): unknown {
  if (typeof entry === "string") return substituteString(entry, environment, missing)
  if (Array.isArray(entry))
    return entry.map((content) => substituteEntry(content, environment, missing))
  if (entry === null || typeof entry !== "object") return entry
  return Object.fromEntries(
    Object.entries(entry).map(([key, content]) => [
      key,
      substituteEntry(content, environment, missing),
    ]),
  )
}

function isHttpUrl(candidate: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(candidate).protocol)
  } catch (error) {
    if (error instanceof TypeError) return false
    throw error
  }
}

function resolvedPreset(request: PresetRequest): ResolvedPreset {
  const missing = new Set<string>()
  const config = substituteEntry(preset(request), request.environment, missing) as Mcp.ServerConfig
  const names = [...missing].sort()
  const safe = names.length ? { ...config, disabled: true } : config
  if (!names.length && safe.type === "remote" && !isHttpUrl(safe.url))
    throw new Error(`mcp.servers.${request.name}.url: esperada URL HTTP(S)`)
  return { name: request.name, config: safe, missing: names }
}

function presets(
  options: ResolvedMcpOptions,
  packageManager: PackageManager,
  environment: Environment,
  projectRoot: string | undefined,
) {
  return MCP_SERVER_IDS.filter((name) => !options.servers[name].disabled).map((name) =>
    resolvedPreset({ name, options, packageManager, environment, projectRoot }),
  )
}

/** Contribution facts for the doctor: command and booleans, never secret values. */
function skillsContribution(entry: ResolvedPreset): SkillsContribution {
  const config = entry.config.type === "local" ? entry.config : undefined
  const environment = config?.environment
  const command = config?.command ?? []
  return {
    origin: "omo",
    command,
    pinned: isPinnedSkillsCommand(command),
    mutationsEnabled: environment?.SKILLS_ALLOW_MUTATIONS === "true",
    projectRootConfigured: environment?.SKILLS_PROJECT_ROOT !== undefined,
  }
}

function contribute(
  editor: McpEditor,
  presets: readonly ResolvedPreset[],
  problems: McpProblem[],
): SkillsContribution {
  problems.length = 0
  let contribution: SkillsContribution = { origin: "absent" }
  for (const preset of presets) {
    if (editor.get(preset.name) !== undefined) {
      if (preset.name === "skills") contribution = { origin: "host" }
      continue
    }
    editor.set(preset.name, structuredClone(preset.config))
    if (preset.name === "skills") contribution = skillsContribution(preset)
    if (preset.missing.length)
      problems.push({ name: preset.name, missingEnvironment: preset.missing })
  }
  return contribution
}

export async function mountMcp(
  ctx: Plugin.Context,
  options: ResolvedMcpOptions,
  packageManager: PackageManager,
  configPath: string,
) {
  const problems: McpProblem[] = []
  if (!options.enabled)
    return {
      dispose: async () => {},
      problems,
      skillsContribution: { origin: "absent" } as const,
    }
  const projectRoot = existsSync(ctx.location.directory) ? ctx.location.directory : undefined
  const built = presets(
    options,
    packageManager,
    await loadConfigEnvironment(configPath),
    projectRoot,
  )
  let skillsContribution: SkillsContribution = { origin: "absent" }
  const registration = await ctx.mcp.transform((editor) => {
    skillsContribution = contribute(editor, built, problems)
  })
  return { dispose: () => registration.dispose(), problems, skillsContribution }
}
