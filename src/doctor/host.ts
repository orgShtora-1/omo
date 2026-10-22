/**
 * Binds `diagnose` to the real host. Everything here is a read: capability
 * observation reads the live context object, probes reuse the bounded-spawn
 * seam, and permissions are read through the only list operation the plugin
 * domain exposes.
 *
 * Capability observation deliberately inspects the runtime object rather than
 * the `.d.ts` declarations. A declaration proves the SDK *has* a member; only
 * the live object proves *this host* exposes it, which is what a compatibility
 * report is supposed to answer.
 */

import { createRequire } from "node:module"
import type { Mcp, Plugin } from "@opencode/plugin"
import type { PackageManager } from "../config/schema.js"
import { eventDiagnostics } from "../events/diagnostics.js"
import { ProcessError, runBounded } from "../subprocess.js"
import type {
  DoctorInputs,
  ModelRefLike,
  OptionalService,
  PendingPermissionLike,
  ProbeResult,
  ToolLike,
} from "./diagnose.js"
import type { McpRegistrationObservation } from "./mcp.js"

/** Lowest `@opencode/plugin` this build supports. Tripwire-tested against package.json. */
export const SDK_FLOOR = "2.0.32"

/**
 * The host release this build was verified against: OpenCode 2.0.32
 * on Windows with Bun 1.4.2, confirmed by an end-to-end live delegation
 * probe (omo_delegate admission, child run and terminal outcome) on
 * 2026-10-18. This is a verified baseline, not a vendor-declared
 * minimum: older hosts at the SDK floor may work, and the report says so
 * instead of failing the run.
 */
export const VERIFIED_HOST = "2.0.32"

/** Probes never outlive this budget; a hung binary must not hang the doctor. */
const PROBE_TIMEOUT_MS = 5_000

const isFunction = (value: unknown): boolean => typeof value === "function"

/** Read one member off a live domain without asserting its declared shape. */
const member = (domain: unknown, name: string): unknown =>
  (domain as Record<string, unknown> | null | undefined)?.[name]

/** Each capability is one observable member of the live context. */
const CAPABILITY_PROBES: Record<string, (ctx: Plugin.Context) => boolean> = {
  "session.create": (ctx) => isFunction(member(ctx.session, "create")),
  "session.prompt": (ctx) => isFunction(member(ctx.session, "prompt")),
  "session.hook": (ctx) => isFunction(member(ctx.session, "hook")),
  "session.synthetic": (ctx) => isFunction(member(ctx.session, "synthetic")),
  "session.context": (ctx) => isFunction(member(ctx.session, "context")),
  "tool.transform": (ctx) => isFunction(member(ctx.tool, "transform")),
  "tool.hook": (ctx) => isFunction(member(ctx.tool, "hook")),
  "command.transform": (ctx) => isFunction(member(ctx.command, "transform")),
  "permission.list": (ctx) => isFunction(member(ctx.permission, "list")),
  "mcp.transform": (ctx) => isFunction(member(ctx.mcp, "transform")),
}

export function observeCapabilities(ctx: Plugin.Context): readonly string[] {
  return Object.entries(CAPABILITY_PROBES)
    .filter(([, probe]) => {
      try {
        return probe(ctx)
      } catch {
        // A domain that cannot even be read is an absent capability, not a crash.
        return false
      }
    })
    .map(([id]) => id)
}

/** The installed SDK version, read from the resolved package manifest. */
async function readSdkVersion(): Promise<string> {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve("@opencode/plugin/package.json")
  const parsed = JSON.parse(await Bun.file(manifest).text()) as { version?: unknown }
  if (typeof parsed.version !== "string" || !parsed.version)
    throw new Error("the installed @opencode/plugin manifest declares no version")
  return parsed.version
}

async function readRuntimeVersion(): Promise<string> {
  if (typeof Bun !== "undefined" && Bun.version) return `bun ${Bun.version}`
  return `node ${process.versions.node}`
}

/**
 * Run a `--version` probe.
 *
 * `spawn` failure is confirmed absence (the binary is not there) and a
 * non-zero exit is confirmed absence too; both are facts. A timeout or an
 * abort is *not* a fact about the binary, so it propagates and the report
 * records the check as `unknown`.
 */
async function probeVersion(command: string, args: string[]): Promise<ProbeResult> {
  let result: Awaited<ReturnType<typeof runBounded>>
  try {
    result = await runBounded(command, args, {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxStdout: 4_096,
      maxStderr: 4_096,
    })
  } catch (error) {
    if (error instanceof ProcessError && error.code === "spawn")
      return { available: false, reason: `${command} is not installed` }
    throw error
  }
  if (result.exit !== 0)
    return {
      available: false,
      reason: `${command} exited ${result.exit}${result.stderr ? `: ${result.stderr}` : ""}`,
    }
  return { available: true, version: result.stdout.trim() || `${command} responded` }
}

const probeGit = () => probeVersion("git", ["--version"])

/**
 * tmux is probed as a binary because tmux is a binary. LSP is not: its
 * availability in this plugin is a configuration fact, so it is reported as
 * configuration and labelled as such rather than dressed up as a probe result.
 */
async function probeOptional(
  service: OptionalService,
  config: LspConfigFact,
): Promise<ProbeResult> {
  if (service === "tmux") return probeVersion("tmux", ["-V"])
  return config.enabled && config.servers.length
    ? {
        available: true,
        version: `${config.servers.length} configured server(s)`,
        note: CONFIGURATION_NOTE,
      }
    : {
        available: false,
        reason: config.enabled
          ? "no LSP server is configured for this project"
          : "LSP is disabled in the project configuration",
        note: CONFIGURATION_NOTE,
      }
}

const CONFIGURATION_NOTE =
  "Observed from the project configuration; a configured server is not a started server."

/** What the doctor needs to know about LSP without depending on the LSP module. */
interface LspConfigFact {
  readonly enabled: boolean
  readonly servers: readonly unknown[]
}

export interface HostDoctorOptions {
  readonly lsp?: LspConfigFact
  readonly requiredModels?: readonly ModelRefLike[]
  readonly signal?: AbortSignal
  readonly now?: () => number
  /** Resolved automatic contribution state, so absent means intentionally disabled or a defect. */
  readonly mcpRegistration?: McpRegistrationObservation
  /** Package manager OmO uses, surfaced in the skills-server remediation. */
  readonly packageManager?: PackageManager
}

interface LiveMcpDomain {
  readonly list?: (input: {
    readonly location: { readonly directory: string }
  }) => Promise<{ readonly data: readonly Mcp.Server[] }>
}

interface LiveToolDomain {
  readonly list?: () => Promise<unknown>
}

/** Assemble the real host's observations for one diagnosis. */
export function hostDoctorInputs(
  ctx: Plugin.Context,
  sessionID: string,
  options: HostDoctorOptions = {},
): DoctorInputs {
  const list = ctx.model.list as unknown as (input: Record<string, never>) => Promise<{
    data?: Array<{ providerID?: string; id?: string; variants?: Record<string, unknown> }>
  }>
  const listPending = ctx.permission.list as unknown as (input: {
    sessionID: string
  }) => Promise<
    ReadonlyArray<{ id?: string; action?: string; resources?: string[] } | null | undefined>
  >
  const directory = (ctx.location as { directory?: unknown } | undefined)?.directory
  const mcp = (ctx as unknown as { mcp?: LiveMcpDomain }).mcp
  const liveMcpList = typeof mcp?.list === "function" ? mcp.list : undefined
  const listMcpServers =
    typeof directory === "string" && directory.length > 0 && liveMcpList
      ? async () => {
          const response = await liveMcpList({ location: { directory } })
          return response.data
        }
      : undefined
  const tool = (ctx as unknown as { tool?: LiveToolDomain }).tool
  const liveToolList = typeof tool?.list === "function" ? tool.list : undefined
  const listTools = liveToolList
    ? async () => {
        // A host list is untrusted input: wrapped shapes are unwrapped and
        // partial entries dropped, never dereferenced blindly.
        const response = await liveToolList()
        const raw = Array.isArray(response)
          ? response
          : typeof response === "object" &&
              response !== null &&
              Array.isArray((response as { data?: unknown }).data)
            ? (response as { data: unknown[] }).data
            : []
        return raw.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) return []
          const name = (entry as { name?: unknown }).name
          if (typeof name !== "string") return []
          // Registry attribution: the host tags MCP tools with their owning
          // server in options.namespace; malformed values are dropped, never
          // trusted.
          const options = (entry as { options?: unknown }).options
          const namespace =
            typeof options === "object" &&
            options !== null &&
            typeof (options as { namespace?: unknown }).namespace === "string"
              ? (options as { namespace: string }).namespace
              : undefined
          return [{ name, ...(namespace !== undefined ? { namespace } : {}) }] satisfies ToolLike[]
        })
      }
    : undefined
  return {
    app: ctx.app,
    readSdkVersion,
    readRuntimeVersion,
    observeCapabilities: () => observeCapabilities(ctx),
    listModels: async () => {
      const response = await list({})
      return (response.data ?? []).flatMap((model) => {
        if (typeof model.providerID !== "string" || typeof model.id !== "string") return []
        const base = { providerID: model.providerID, modelID: model.id }
        const variants = Object.keys(model.variants ?? {})
        return variants.length ? variants.map((variant) => ({ ...base, variant })) : [base]
      }) satisfies readonly ModelRefLike[]
    },
    probeGit,
    probeOptional: (service) =>
      probeOptional(service, options.lsp ?? { enabled: false, servers: [] }),
    ...(listMcpServers ? { listMcpServers } : {}),
    ...(listTools ? { listTools } : {}),
    ...(options.mcpRegistration ? { mcpRegistration: options.mcpRegistration } : {}),
    listPendingPermissions: async () => {
      const requests = await listPending({ sessionID })
      return (Array.isArray(requests) ? requests : []).flatMap((request) => {
        // A host list is untrusted input: a null or partial entry must be
        // dropped, never dereferenced.
        if (!request || typeof request.id !== "string" || typeof request.action !== "string")
          return []
        return [
          {
            id: request.id,
            action: request.action,
            resources: Array.isArray(request.resources) ? request.resources : [],
          },
        ] satisfies PendingPermissionLike[]
      })
    },
    // The in-process loop counters are plugin state, not host state: reading
    // the shared diagnostics singleton keeps a silently dead event stream
    // observable from the read-only report.
    observeEvents: () => eventDiagnostics.snapshot(),
    requiredSdk: SDK_FLOOR,
    requiredHost: VERIFIED_HOST,
    ...(options.packageManager ? { packageManager: options.packageManager } : {}),
    ...(options.requiredModels ? { requiredModels: options.requiredModels } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.now ? { now: options.now } : {}),
  }
}
