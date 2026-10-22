/**
 * Live MCP observations for the feature OmO contributes through the host
 * plugin API. The doctor deliberately does not infer runtime state from
 * opencode.json(c): the host reconciles plugin transforms with host overrides,
 * so ctx.mcp.list is the only surface that can report what is connected.
 */
import type { Mcp } from "@opencode/plugin"
import { DEFAULT_PACKAGE_MANAGER, skillsMcpCommand } from "../config/runtime.js"
import type { PackageManager } from "../config/schema.js"
import type { McpServerID } from "../mcp/config.js"
import type { McpProblem, SkillsContribution } from "../mcp/registry.js"
import type { CheckStatus, DoctorCheck, ToolLike } from "./diagnose.js"

const RECOMMENDED_MCP_SERVERS = ["github", "context7", "skills"] as const
type RecommendedMcpServer = (typeof RECOMMENDED_MCP_SERVERS)[number]
const OPTIONAL_MCP_SERVERS = ["vercel", "cloudflare"] as const

/** MCP server name the skills preset contributes. */
const SKILLS_MCP_SERVER = "skills" as const
/** Permission-action prefix the host composes for skills tools. */
export const SKILLS_TOOL_PREFIX = "skills_" as const
/**
 * Raw tool names the pinned `@shtora/skills@0.1.0` server advertises; the first
 * five are the discovery set. OpenCode 2.0.32 registers MCP tools in the
 * tool registry under these raw names and attributes the owning server through
 * `Tool.Info.options.namespace`, so capability matching keys on the namespace.
 */
export const SKILLS_MCP_SERVER_TOOLS = [
  "search_skills",
  "get_skill",
  "get_skill_audits",
  "get_top_skills",
  "get_official_skills",
  "list_installed_skills",
  "check_skill_updates",
  "install_skill",
  "update_skill",
  "remove_skill",
] as const
/**
 * Composed `<server>_<tool>` permission-action names for the pinned
 * `@shtora/skills@0.1.0` catalog; the first five are discovery tools. Kept for
 * consumers that reason about permission actions, and as the legacy fallback
 * registries without namespace attribution.
 */
export const SKILLS_MCP_TOOLS = [
  "skills_search_skills",
  "skills_get_skill",
  "skills_get_skill_audits",
  "skills_get_top_skills",
  "skills_get_official_skills",
  "skills_list_installed_skills",
  "skills_check_skill_updates",
  "skills_install_skill",
  "skills_update_skill",
  "skills_remove_skill",
] as const

export interface McpRegistrationObservation {
  /** Automatic contribution is disabled globally by the active omo.jsonc. */
  readonly enabled: boolean
  /** Built-in server IDs disabled by the active omo.jsonc. */
  readonly disabledServers: readonly McpServerID[]
  /** Secret-safe environment names the registry could not resolve. */
  readonly problems: readonly McpProblem[]
  /** Registration facts for the skills entry; absent on older observations. */
  readonly skills?: SkillsContribution
}

interface CheckOptions {
  readonly packageManager?: PackageManager
}

type ServerState = Mcp.Server["status"]["status"]

const disabledObservation = (): McpRegistrationObservation => ({
  enabled: false,
  disabledServers: [...RECOMMENDED_MCP_SERVERS, ...OPTIONAL_MCP_SERVERS],
  problems: [],
})

const isDisabled = (registration: McpRegistrationObservation, server: McpServerID): boolean =>
  registration.disabledServers.includes(server)

const problemFor = (
  registration: McpRegistrationObservation,
  server: McpServerID,
): McpProblem | undefined => registration.problems.find((problem) => problem.name === server)

function stateStatus(
  server: RecommendedMcpServer,
  state: Mcp.Server | undefined,
  registration: McpRegistrationObservation,
): CheckStatus {
  if (state === undefined) {
    return registration.enabled && !isDisabled(registration, server) ? "fail" : "skipped"
  }
  if (state.status.status === "connected") return "pass"
  if (state.status.status === "failed" || state.status.status === "needs_auth") return "fail"
  return "skipped"
}

function observedState(
  server: RecommendedMcpServer,
  state: Mcp.Server | undefined,
  registration: McpRegistrationObservation,
): Record<string, unknown> {
  const problem = problemFor(registration, server)
  return {
    status: state?.status.status ?? "absent",
    automaticRegistration: registration.enabled && !isDisabled(registration, server),
    ...(problem ? { missingEnvironment: problem.missingEnvironment } : {}),
  }
}

function absentRemediation(server: RecommendedMcpServer, packageManager: PackageManager): string {
  const command = skillsMcpCommand(packageManager).join(" ")
  if (server === "skills") {
    return `OmO should have contributed skills with \`${command}\`. Restart OpenCode or reload the project; if it persists, inspect the plugin and MCP logs.`
  }
  return `OmO should have contributed ${server}. Restart OpenCode or reload the project; if it persists, inspect the plugin and MCP logs.`
}

function remediationFor(
  server: RecommendedMcpServer,
  state: Mcp.Server | undefined,
  registration: McpRegistrationObservation,
  packageManager: PackageManager,
): string | undefined {
  if (!registration.enabled)
    return "Enable mcp.enabled in omo.jsonc to let OmO register its built-in MCP servers."
  if (isDisabled(registration, server))
    return `Remove mcp.servers.${server}.disabled in omo.jsonc or provide an enabled host override.`
  if (state === undefined) return absentRemediation(server, packageManager)
  const problem = problemFor(registration, server)
  if (state.status.status === "disabled" && problem) {
    return `Provide ${problem.missingEnvironment.join(", ")} or replace the server configuration in omo.jsonc.`
  }
  if (state.status.status === "disabled")
    return `Enable ${server} in omo.jsonc or remove the disabling host override.`
  if (state.status.status === "pending")
    return `Wait for the host to finish connecting to ${server}, or inspect it with /mcps.`
  if (state.status.status === "failed") {
    return `Review ${server} with /mcps or the OpenCode logs; OmO omits the host error text from diagnostics to avoid exposing service details.`
  }
  if (state.status.status === "needs_auth") {
    return `Authorize ${server} through /mcps, or provide the credential it needs in the environment.`
  }
  return undefined
}

function serverCheck(
  server: RecommendedMcpServer,
  states: ReadonlyMap<string, Mcp.Server>,
  registration: McpRegistrationObservation,
  options: CheckOptions,
): DoctorCheck {
  const state = states.get(server)
  const remediation = remediationFor(
    server,
    state,
    registration,
    options.packageManager ?? DEFAULT_PACKAGE_MANAGER,
  )
  return {
    id: `mcp-${server}`,
    title: `MCP server ${server}`,
    status: stateStatus(server, state, registration),
    required: false,
    observed: observedState(server, state, registration),
    ...(remediation ? { remediation } : {}),
    note: "Observed from the live host MCP registry; connection and authorization remain host-owned.",
  }
}

const namesWith = (states: readonly Mcp.Server[], requested: ServerState): string[] =>
  states.filter((entry) => entry.status.status === requested).map((entry) => entry.name)

function optionalCheck(states: ReadonlyMap<string, Mcp.Server>): DoctorCheck | undefined {
  const present = OPTIONAL_MCP_SERVERS.map((server) => states.get(server)).filter(
    (entry): entry is Mcp.Server => entry !== undefined,
  )
  if (present.length === 0) return undefined
  const failed = [...namesWith(present, "failed"), ...namesWith(present, "needs_auth")]
  const connected = namesWith(present, "connected")
  return {
    id: "mcp-optional",
    title: "MCP opt-in servers",
    status: failed.length > 0 ? "fail" : connected.length > 0 ? "pass" : "skipped",
    required: false,
    observed: {
      connected,
      pending: namesWith(present, "pending"),
      disabled: namesWith(present, "disabled"),
      failed,
    },
    ...(failed.length > 0
      ? { remediation: "Authorize or repair the failed opt-in server through /mcps." }
      : {}),
  }
}

/**
 * Build one optional check per built-in server from live host state. Raw host
 * errors are intentionally not copied into the report: MCP errors can contain
 * endpoint or credential details, and the user sees them through /mcps.
 */
export function buildMcpChecks(
  servers: readonly Mcp.Server[],
  registration: McpRegistrationObservation = disabledObservation(),
  options: CheckOptions = {},
): DoctorCheck[] {
  const states = new Map(servers.map((server) => [server.name, server]))
  const checks = RECOMMENDED_MCP_SERVERS.map((server) =>
    serverCheck(server, states, registration, options),
  )
  const optional = optionalCheck(states)
  return optional ? [...checks, optional] : checks
}

/**
 * Effective skills tool names from the live registry. OpenCode 2.0.32
 * registers MCP tools under raw names with the owning server attributed in
 * `options.namespace`; that attribution is authoritative. Registries without
 * namespace information (older hosts) keyed tools by the composed
 * `skills_<tool>` permission name, so those entries are unwrapped for
 * comparison. A raw or prefixed name owned by another server never counts.
 */
function skillsToolNames(tools: readonly ToolLike[]): string[] {
  const names = new Set<string>()
  for (const tool of tools) {
    if (tool.namespace === SKILLS_MCP_SERVER) {
      names.add(tool.name)
      continue
    }
    if (tool.namespace === undefined && tool.name.startsWith(SKILLS_TOOL_PREFIX)) {
      names.add(tool.name.slice(SKILLS_TOOL_PREFIX.length))
    }
  }
  return [...names]
}

/**
 * Compare the live skills tool catalog with the pinned 0.1.0 expectation.
 * The check observes capabilities (registered tools), never version metadata
 * or secret values; `registration.skills` carries only facts OmO contributed
 * and its origin is informational — a host-defined skills entry (or a
 * contribution snapshot taken before the registration transform ran) is never
 * treated as a missing server, because connection comes from ctx.mcp.list and
 * tool ownership from the registry namespace.
 */
export function buildSkillsCapabilityCheck(
  servers: readonly Mcp.Server[],
  registration: McpRegistrationObservation = disabledObservation(),
  tools: readonly ToolLike[],
): DoctorCheck {
  const contribution = registration.skills ?? { origin: "absent" as const }
  const observed: Record<string, unknown> = { origin: contribution.origin }
  if (contribution.origin === "omo") {
    observed.command = contribution.command.join(" ")
    observed.pinned = contribution.pinned
    observed.mutationsEnabled = contribution.mutationsEnabled
    observed.projectRootConfigured = contribution.projectRootConfigured
  }
  const base = {
    id: "mcp-skills-capability",
    title: "Skills MCP capabilities",
    required: false,
    observed,
    note: "Capability-based observation of the live tool catalog; not version metadata.",
  }
  if (!registration.enabled || isDisabled(registration, "skills"))
    return {
      ...base,
      status: "skipped" as CheckStatus,
      observed: { ...observed, server: "disabled" },
    }
  const state = servers.find((server) => server.name === "skills")
  if (state === undefined)
    return {
      ...base,
      status: "skipped" as CheckStatus,
      observed: { ...observed, server: "absent" },
    }
  if (state.status.status !== "connected")
    return {
      ...base,
      status: "skipped" as CheckStatus,
      observed: { ...observed, server: state.status.status },
      note: "Tools are observable only while the server is connected.",
    }
  // Past this point the registry reports the server connected, so the origin
  // fact alone must never read as "server missing".
  const connectedObserved = { ...observed, server: "connected" as const }
  const expected: readonly string[] = SKILLS_MCP_SERVER_TOOLS
  const names = skillsToolNames(tools)
  if (names.length === 0)
    return {
      ...base,
      status: "fail" as CheckStatus,
      observed: { ...connectedObserved, tools: 0 },
      remediation:
        "The skills server is connected but exposes no skills tools; inspect /mcps and the OpenCode logs.",
    }
  const legacyOnly =
    expected.slice(0, 5).every((name) => names.includes(name)) &&
    !expected.slice(5).some((name) => names.includes(name))
  if (legacyOnly)
    return {
      ...base,
      status: "fail" as CheckStatus,
      observed: { ...connectedObserved, tools: names.length },
      remediation:
        "Only the discovery tools are live. Clear the package runner cache or restart the host so the pinned @shtora/skills@0.1.0 runs.",
    }
  const missing = expected.filter((name) => !names.includes(name))
  if (missing.length === 0)
    return {
      ...base,
      status: "pass" as CheckStatus,
      observed: {
        ...connectedObserved,
        tools: names.length,
        extra: names.filter((name) => !expected.includes(name)),
      },
    }
  return {
    ...base,
    status: "unknown" as CheckStatus,
    observed: { ...connectedObserved, tools: names },
  }
}
