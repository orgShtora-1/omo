/**
 * Compatibility doctor: a read-only diagnosis of the environment OmO actually
 * runs in. It observes what the host exposes and never changes operational
 * state — no installs, no credential access, no paid inference, no permission
 * requests, no restart.
 *
 * Two distinctions are load-bearing and must not be collapsed:
 *
 * - **required vs optional.** A missing optional service (LSP, tmux) degrades
 *   exactly one feature; a missing required capability is an incompatibility.
 * - **confirmed vs unavailable information.** A probe that throws is
 *   `unknown`, not `fail`: "we could not read it" is not "it is broken".
 *
 * Pending permission requests are reported as observed requests only.
 * `permission.list` returns what the host is currently asking about — it does
 * not return rule effects, and an observed pending request does not prove the
 * host would grant it, because the effective decision also depends on the
 * agent, the project and the concrete operation.
 */

import type { Mcp } from "@opencode/plugin"
import type { PackageManager } from "../config/schema.js"
import type { EventDiagnosticsSnapshot } from "../events/diagnostics.js"
import {
  buildMcpChecks,
  buildSkillsCapabilityCheck,
  type McpRegistrationObservation,
} from "./mcp.js"

export type CheckStatus = "pass" | "fail" | "skipped" | "unknown"

export interface DoctorCheck {
  readonly id: string
  readonly title: string
  readonly status: CheckStatus
  /** Required checks decide the overall status; optional ones never block. */
  readonly required: boolean
  readonly observed?: Record<string, unknown>
  readonly remediation?: string
  readonly note?: string
}

type ReportStatus = "ok" | "degraded" | "fail" | "cancelled"

export interface DoctorReport {
  readonly schemaVersion: 1
  readonly status: ReportStatus
  readonly generatedAt: number
  readonly checks: readonly DoctorCheck[]
  /** Features that work regardless of the failing checks. */
  readonly independentFeatures: readonly string[]
  /** Features a failed required check actually takes away. */
  readonly blockedFeatures: readonly string[]
}

/** The host/SDK capabilities the plugin genuinely relies on. */
export const REQUIRED_CAPABILITIES = [
  "session.create",
  "session.prompt",
  "session.hook",
  "session.synthetic",
  "session.context",
  "tool.transform",
  "tool.hook",
  "command.transform",
  "permission.list",
  "mcp.transform",
] as const

/** Features whose absence of Git does not stop them. */
const GIT_INDEPENDENT = [
  "delegation",
  "plans",
  "memory",
  "sessions",
  "goal",
  "teams",
  "hashline",
] as const

export interface ModelRefLike {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

export interface ProbeResult {
  readonly available: boolean
  readonly version?: string
  readonly reason?: string
  /** How the fact was obtained, when that limits what the fact proves. */
  readonly note?: string
}

export type OptionalService = "lsp" | "tmux"

/** Mirrors `PermissionRequest` as the host returns it: an ask, not a decision. */
export interface PendingPermissionLike {
  readonly id: string
  readonly action: string
  readonly resources: readonly string[]
}

/** Minimal live-tool shape: the effective registry name plus host attribution. */
export interface ToolLike {
  readonly name: string
  /**
   * Namespace the host attributes the tool to. MCP tools registered by the
   * host carry their owning server name here (for example "skills"); the
   * skills capability check treats this attribution as authoritative.
   */
  readonly namespace?: string
}

export interface DoctorInputs {
  /** Host identity, observed from the plugin context. */
  readonly app: { readonly name: string; readonly version: string; readonly channel: string }
  readonly readSdkVersion: () => Promise<string>
  readonly readRuntimeVersion: () => Promise<string>
  /** Capability strings the host surface actually exposes right now. */
  readonly observeCapabilities: () => readonly string[]
  readonly listModels: () => Promise<readonly ModelRefLike[]>
  readonly probeGit: () => Promise<ProbeResult>
  readonly probeOptional: (service: OptionalService) => Promise<ProbeResult>
  readonly listPendingPermissions: () => Promise<readonly PendingPermissionLike[]>
  /**
   * Live MCP server states from the host registry. Absent when the caller
   * cannot call ctx.mcp.list; the report then names that missing observation.
   */
  readonly listMcpServers?: () => Promise<readonly Mcp.Server[]>
  /**
   * Live tool names from the host registry. Absent when the caller cannot
   * call ctx.tool.list; the skills capability check is then omitted.
   */
  readonly listTools?: () => Promise<readonly ToolLike[]>
  /**
   * The built-in MCP contribution resolved before registration, used only to
   * distinguish an intentionally disabled server from one that should exist.
   */
  readonly mcpRegistration?: McpRegistrationObservation
  /**
   * In-process counters of the plugin's idle-wake and goal-continuation event
   * loops. Absent when the caller cannot observe them (synthetic harnesses);
   * a live report always exposes the counters so a silently dead event stream
   * is visible instead of swallowed.
   */
  readonly observeEvents?: () => EventDiagnosticsSnapshot
  /**
   * Package manager OmO uses for its runtime commands; selects the runner
   * named in the skills-server remediation. Defaults to bun.
   */
  readonly packageManager?: PackageManager
  /** Lowest plugin SDK version this build supports. */
  readonly requiredSdk: string
  /**
   * Lowest host version this build supports. Defaults to the SDK floor: the host
   * and the SDK ship together, so one floor is right unless a release widens
   * the gap. Never inferred from the observed host.
   */
  readonly requiredHost?: string
  readonly requiredModels?: readonly ModelRefLike[]
  readonly signal?: AbortSignal
  readonly now?: () => number
}

const parseVersion = (raw: string): number[] | undefined => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!match) return undefined
  const [, major, minor, patch] = match
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return [Number(major), Number(minor), Number(patch)]
}

const atLeast = (actual: string, minimum: string): "pass" | "fail" | "unknown" => {
  const left = parseVersion(actual)
  const right = parseVersion(minimum)
  if (!left || !right) return "unknown"
  for (let index = 0; index < 3; index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a > b) return "pass"
    if (a < b) return "fail"
  }
  return "pass"
}

class Cancelled extends Error {
  constructor() {
    super("doctor cancelled")
    this.name = "Cancelled"
  }
}

const guard = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) throw new Cancelled()
}

/** Run one observation, converting any throw into `unknown` rather than a failure. */
async function observe(
  operation: () => Promise<unknown>,
  onError: (error: unknown) => CheckStatus | { status: CheckStatus; reason: string },
): Promise<{ status: CheckStatus; reason?: string; value?: unknown }> {
  try {
    return { status: "pass", value: await operation() }
  } catch (error) {
    const outcome = onError(error)
    return typeof outcome === "string"
      ? { status: outcome }
      : { status: outcome.status, reason: outcome.reason }
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function diagnose(inputs: DoctorInputs): Promise<DoctorReport> {
  const signal = inputs.signal
  const now = inputs.now ?? Date.now
  if (signal?.aborted)
    return {
      schemaVersion: 1,
      status: "cancelled",
      generatedAt: now(),
      checks: [],
      independentFeatures: [],
      blockedFeatures: [],
    }

  const checks: DoctorCheck[] = []

  // Host version: the plugin runs inside this process, so an unsupported host
  // is a confirmed incompatibility, not a warning.
  const requiredHost = inputs.requiredHost ?? inputs.requiredSdk
  const hostStatus = atLeast(inputs.app.version, requiredHost)
  checks.push({
    id: "host-version",
    title: "Host version",
    status: hostStatus,
    required: true,
    observed: {
      name: inputs.app.name,
      version: inputs.app.version,
      channel: inputs.app.channel,
      required: requiredHost,
    },
    ...(hostStatus === "fail"
      ? {
          remediation: `Upgrade the opencode host to ${requiredHost} or newer; observed ${inputs.app.version}.`,
        }
      : hostStatus === "unknown"
        ? {
            remediation: `Host reported an unparsable version (${inputs.app.version}); compare it with ${requiredHost} manually.`,
          }
        : {}),
  })

  const sdk = await observe(
    () => inputs.readSdkVersion(),
    (error) => ({
      status: "unknown" as const,
      reason: message(error),
    }),
  )
  guard(signal)
  if (sdk.status === "unknown") {
    checks.push({
      id: "sdk-version",
      title: "Plugin SDK version",
      status: "unknown",
      required: true,
      observed: { reason: sdk.reason },
      remediation:
        "The SDK version could not be read from the host; verify the installed @opencode/plugin matches the pinned version.",
    })
  } else {
    const version = String(sdk.value)
    const status = atLeast(version, inputs.requiredSdk)
    checks.push({
      id: "sdk-version",
      title: "Plugin SDK version",
      status,
      required: true,
      observed: { version, required: inputs.requiredSdk },
      ...(status === "fail"
        ? {
            remediation: `Install @opencode/plugin ${inputs.requiredSdk} or newer; observed ${version}.`,
          }
        : {}),
    })
  }

  const runtime = await observe(
    () => inputs.readRuntimeVersion(),
    (error) => ({
      status: "unknown" as const,
      reason: message(error),
    }),
  )
  guard(signal)
  if (runtime.status === "unknown") {
    checks.push({
      id: "runtime-version",
      title: "Runtime version",
      status: "unknown",
      required: false,
      observed: { reason: runtime.reason },
      remediation:
        "The runtime version could not be read; the plugin falls back to the host's capabilities.",
    })
  } else {
    const version = String(runtime.value)
    checks.push({
      id: "runtime-version",
      title: "Runtime version",
      status: "pass",
      required: false,
      observed: { version },
    })
  }

  const available = inputs.observeCapabilities()
  const missing = REQUIRED_CAPABILITIES.filter((capability) => !available.includes(capability))
  checks.push({
    id: "capabilities",
    title: "Required host capabilities",
    status: missing.length ? "fail" : "pass",
    required: true,
    observed: { required: [...REQUIRED_CAPABILITIES], available: [...available], missing },
    ...(missing.length
      ? {
          remediation: `This host does not expose ${missing.join(", ")}; update the host or the plugin expects capabilities unavailable here.`,
        }
      : {}),
  })

  const catalogue = await observe(
    () => inputs.listModels(),
    (error) => ({
      status: "unknown" as const,
      reason: message(error),
    }),
  )
  guard(signal)
  if (catalogue.status === "unknown") {
    checks.push({
      id: "models",
      title: "Model availability",
      status: "unknown",
      required: false,
      observed: { reason: catalogue.reason },
      remediation:
        "The model catalogue could not be listed; check provider credentials in the host rather than in this plugin.",
    })
  } else {
    const models = catalogue.value as readonly ModelRefLike[]
    const absent = (inputs.requiredModels ?? []).filter(
      (wanted) =>
        !models.some(
          (model) =>
            model.providerID === wanted.providerID &&
            model.modelID === wanted.modelID &&
            (wanted.variant === undefined || model.variant === wanted.variant),
        ),
    )
    if (!models.length) {
      checks.push({
        id: "models",
        title: "Model availability",
        status: "fail",
        required: false,
        observed: { count: 0, missing: [...(inputs.requiredModels ?? [])] },
        remediation:
          "No model is available in this host, so delegation cannot resolve a model. Authenticate a provider in the host.",
      })
    } else if (absent.length) {
      checks.push({
        id: "models",
        title: "Model availability",
        status: "fail",
        required: false,
        observed: {
          count: models.length,
          missing: absent.map((model) => `${model.providerID}/${model.modelID}`),
        },
        remediation: `Unavailable model(s): ${absent
          .map((model) => `${model.providerID}/${model.modelID}`)
          .join(", ")}. Change the configured model or enable the provider.`,
      })
    } else {
      checks.push({
        id: "models",
        title: "Model availability",
        status: "pass",
        required: false,
        observed: { count: models.length },
      })
    }
  }

  const git = await observe(
    () => inputs.probeGit(),
    (error) => ({
      status: "unknown" as const,
      reason: message(error),
    }),
  )
  guard(signal)
  if (git.status === "unknown") {
    checks.push({
      id: "git",
      title: "Git",
      status: "unknown",
      required: false,
      observed: { reason: git.reason },
      remediation:
        "Git availability could not be determined. Worktrees and memory commit stay disabled until it is confirmed.",
    })
  } else {
    const probe = git.value as ProbeResult
    checks.push({
      id: "git",
      title: "Git",
      // Absent Git is a confirmed fact, not an unreadable probe: report it as a
      // non-required failure so the report degrades instead of claiming all-clear.
      status: probe.available ? "pass" : "fail",
      required: false,
      observed: { ...probe },
      ...(probe.available
        ? {}
        : {
            remediation: `Git is unavailable (${probe.reason ?? "not found"}). Install Git to enable worktrees and memory commit; plans, memory and sessions are unaffected.`,
          }),
    })
  }

  for (const service of ["lsp", "tmux"] as const) {
    const probe = await observe(
      () => inputs.probeOptional(service),
      (error) => ({
        status: "unknown" as const,
        reason: message(error),
      }),
    )
    guard(signal)
    if (probe.status === "unknown") {
      checks.push({
        id: `optional-${service}`,
        title: `Optional service: ${service}`,
        status: "unknown",
        required: false,
        observed: { reason: probe.reason },
        remediation: `The ${service} probe failed; the feature is left disabled and nothing else changes.`,
      })
      continue
    }
    const { note, ...result } = probe.value as ProbeResult
    checks.push({
      id: `optional-${service}`,
      title: `Optional service: ${service}`,
      status: result.available ? "pass" : "skipped",
      required: false,
      observed: result,
      ...(note ? { note } : {}),
      ...(result.available
        ? {}
        : {
            remediation: `Optional: ${result.reason ?? `${service} unavailable`}. Only the ${service} tools stay unavailable; every other feature works.`,
          }),
    })
  }

  const pending = await observe(
    () => inputs.listPendingPermissions(),
    (error) => ({
      status: "unknown" as const,
      reason: message(error),
    }),
  )
  guard(signal)
  if (pending.status === "unknown") {
    checks.push({
      id: "permissions",
      title: "Pending permission requests",
      status: "unknown",
      required: false,
      observed: { reason: pending.reason },
      remediation: "Pending permission requests could not be listed for this session.",
    })
  } else {
    const observed = pending.value as readonly PendingPermissionLike[]
    checks.push({
      id: "permissions",
      title: "Pending permission requests",
      status: "pass",
      required: false,
      observed: {
        pending: observed.map((request) => ({
          id: request.id,
          action: request.action,
          resources: [...request.resources],
        })),
        // The host reports asks here, not effects; keep the count distinct so a
        // reader cannot mistake a queue depth for a granted authorization.
        count: observed.length,
      },
      note: "Observed pending requests only; a pending request does not imply an effective authorization for a concrete operation.",
    })
  }

  // MCP checks observe the host-managed runtime registry, not the JSONC file:
  // plugin transforms are the source of OmO's defaults, while the host merges
  // overrides and owns every connection and authorization flow.
  const listMcpServers = inputs.listMcpServers
  if (!listMcpServers) {
    checks.push({
      id: "mcp",
      title: "MCP servers",
      status: "skipped",
      required: false,
      observed: { liveRegistry: false },
      remediation:
        "Provide a host context with ctx.mcp.list to diagnose automatic MCP registration and connection state.",
      note: "OmO uses automatic MCP registration through ctx.mcp.transform; it still never writes host configuration.",
    })
  } else {
    const seen = await observe(
      () => listMcpServers(),
      (error) => ({
        status: "unknown" as const,
        reason: message(error),
      }),
    )
    guard(signal)
    if (seen.status === "unknown") {
      checks.push({
        id: "mcp",
        title: "MCP servers",
        status: "unknown",
        required: false,
        observed: { reason: seen.reason },
        remediation:
          "The host MCP registry could not be read; inspect OpenCode's MCP list and logs for the live connection error.",
      })
    } else {
      checks.push(
        ...buildMcpChecks(seen.value as readonly Mcp.Server[], inputs.mcpRegistration, {
          ...(inputs.packageManager ? { packageManager: inputs.packageManager } : {}),
        }),
      )
      const listTools = inputs.listTools
      if (listTools) {
        const toolsSeen = await observe(
          () => listTools(),
          (error) => ({
            status: "unknown" as const,
            reason: message(error),
          }),
        )
        guard(signal)
        if (toolsSeen.status === "unknown") {
          checks.push({
            id: "mcp-skills-capability",
            title: "Skills MCP capabilities",
            status: "unknown",
            required: false,
            observed: { reason: toolsSeen.reason },
            remediation:
              "The live tool catalog could not be read; inspect OpenCode's tool list and logs.",
          })
        } else {
          checks.push(
            buildSkillsCapabilityCheck(
              seen.value as readonly Mcp.Server[],
              inputs.mcpRegistration,
              toolsSeen.value as readonly ToolLike[],
            ),
          )
        }
      }
    }
  }

  // The plugin's own event-loop counters: observed facts about the idle-wake
  // and goal-continuation loops. Both loops swallow per-event failures by
  // design (one bad event must never kill a loop), so without these counters a
  // host that delivers no idle events is indistinguishable from silence.
  const observeEvents = inputs.observeEvents
  if (!observeEvents) {
    checks.push({
      id: "events",
      title: "Event loop activity",
      status: "skipped",
      required: false,
      observed: {},
      remediation:
        "No event-loop diagnostics were supplied; a live omo_doctor run always reports the idle-wake and continuation counters.",
      note: "Unobserved here, not zero: the caller provided no in-process diagnostics observer.",
    })
  } else {
    const observed = await observe(
      async () => observeEvents(),
      (error) => ({
        status: "unknown" as const,
        reason: message(error),
      }),
    )
    guard(signal)
    if (observed.status === "unknown") {
      checks.push({
        id: "events",
        title: "Event loop activity",
        status: "unknown",
        required: false,
        observed: { reason: observed.reason },
        remediation:
          "The in-process event diagnostics could not be read; the idle-wake counters are unobserved rather than zero.",
      })
    } else {
      checks.push({
        id: "events",
        title: "Event loop activity",
        status: "pass",
        required: false,
        observed: observed.value as Record<string, unknown>,
        note: "Observed in-process counters only; zero idle signals while events are seen means the host delivered no idle notification, not that the loops failed.",
      })
    }
  }

  const gitCheck = checks.find((check) => check.id === "git")
  const gitMissing =
    gitCheck?.status === "skipped" || gitCheck?.status === "unknown" || gitCheck?.status === "fail"
  const requiredFailed = checks.some((check) => check.required && check.status === "fail")
  const optionalFailed = checks.some((check) => !check.required && check.status === "fail")
  // An unreadable required check is not an all-clear either: the caller must be
  // able to tell "verified compatible" from "could not verify".
  const requiredUnknown = checks.some((check) => check.required && check.status === "unknown")
  const status: ReportStatus = requiredFailed
    ? "fail"
    : requiredUnknown
      ? "degraded"
      : optionalFailed
        ? "degraded"
        : "ok"

  return {
    schemaVersion: 1,
    status,
    generatedAt: now(),
    checks,
    independentFeatures: gitMissing ? [...GIT_INDEPENDENT] : [],
    blockedFeatures: gitMissing ? ["worktrees", "memory-commit"] : [],
  }
}
