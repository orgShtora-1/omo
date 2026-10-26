import type { PreemptiveCompactionConfig } from "../context/compaction"
import type { ModelRef } from "../contracts"
import type { OsNotificationsConfig } from "../execution/os-notifications"
import { type ResolvedMcpOptions, resolveMcpOptions } from "../mcp/config"
import type { DreamConfig } from "../memory/dream"
import type { ModelFallbackConfig } from "./model-fallback"
import type { ProactiveModelFallbackConfig } from "./model-proactive-fallback"
import { DEFAULT_PACKAGE_MANAGER } from "./runtime"
import type {
  CategoryConfig,
  OmoOptions,
  PackageManager,
  ProfileConfig,
  ToolGuardsConfig,
} from "./schema"

// Defaults exatos da spec aplicados sobre OmoOptions validado.
type ResolvedProfile = Required<Pick<ProfileConfig, "id" | "mode" | "allowWrite">> &
  Pick<ProfileConfig, "model" | "allowedModels" | "thinkMode">

type ResolvedCategory = Required<Pick<CategoryConfig, "id" | "agent">> &
  Pick<CategoryConfig, "model">

export type ResolvedOptions = {
  schemaVersion: 1
  allowedModels?: ModelRef[]
  profiles: ResolvedProfile[]
  categories: ResolvedCategory[]
  execution: {
    maxChildren: number
    timeoutMs: number
    foregroundTimeoutMs: number
    backgroundTimeoutMs: number
    admissionTimeoutMs: number
    staleTimeoutMs: number
    providerLimits: Record<string, number>
    modelLimits: Record<string, number>
    verifyArtifacts: boolean
    maxRetries: number
    maxAttempts: number
    fallback: boolean
    maxDepth?: number
  }
  skills: {
    recommendedLimit: number
    auto: boolean
    required: string[]
    autoInstall: boolean
    requireAuditPass: boolean
    strictAudits: boolean
  }
  runtime: {
    packageManager: PackageManager
  }
  mcp: ResolvedMcpOptions
  hashline_edit: boolean
  memory_enabled: boolean
  memory_dream: DreamConfig
  goal_enabled: boolean
  command_tool_enabled: boolean
  tool_guards: ToolGuardsConfig
  preemptive_compaction: PreemptiveCompactionConfig
  os_notifications: OsNotificationsConfig
  model_fallback: ModelFallbackConfig
  proactive_model_fallback: ProactiveModelFallbackConfig
  teams?: Record<string, unknown>
  lsp?: Record<string, unknown>
  terminal?: Record<string, unknown>
  telemetry?: Record<string, unknown>
}

export function resolveOptions(input: OmoOptions): ResolvedOptions {
  const maxRetries = input.execution.maxRetries ?? 2
  const timeoutMs = input.execution.timeoutMs ?? 20 * 60 * 1000
  return {
    schemaVersion: input.schemaVersion,
    allowedModels: input.allowedModels,
    profiles: input.profiles.map((p) => ({
      id: p.id,
      mode: p.mode,
      allowWrite: p.allowWrite,
      model: p.model,
      ...(p.allowedModels !== undefined ? { allowedModels: p.allowedModels } : {}),
      ...(p.thinkMode !== undefined ? { thinkMode: p.thinkMode } : {}),
    })),
    categories: input.categories.map((c) => ({ id: c.id, agent: c.agent, model: c.model })),
    execution: {
      maxChildren: input.execution.maxChildren ?? 3,
      timeoutMs,
      foregroundTimeoutMs: input.execution.foregroundTimeoutMs ?? timeoutMs,
      backgroundTimeoutMs: input.execution.backgroundTimeoutMs ?? timeoutMs,
      // A queued delegation fails fast with an actionable error instead of
      // leaving the calling tool pending forever when capacity is saturated.
      admissionTimeoutMs: input.execution.admissionTimeoutMs ?? 120_000,
      // A child that shows no observable host progress for this window is
      // treated as hung (provider stall, host restart) and reaped; seeded from
      // the child's last host update so pre-restart zombies die immediately.
      staleTimeoutMs: input.execution.staleTimeoutMs ?? 15 * 60_000,
      providerLimits: input.execution.providerLimits ?? {},
      modelLimits: input.execution.modelLimits ?? {},
      verifyArtifacts: input.execution.verifyArtifacts ?? false,
      maxRetries,
      maxAttempts: input.execution.maxAttempts ?? maxRetries + 1,
      fallback: input.execution.fallback ?? false,
      maxDepth: input.execution.maxDepth,
    },
    skills: {
      recommendedLimit: input.skills.recommendedLimit ?? 5,
      auto: input.skills.auto ?? true,
      required: input.skills.required ?? [],
      autoInstall: input.skills.autoInstall ?? true,
      requireAuditPass: input.skills.requireAuditPass ?? true,
      strictAudits: input.skills.strictAudits ?? false,
    },
    runtime: {
      packageManager: input.runtime.packageManager ?? DEFAULT_PACKAGE_MANAGER,
    },
    mcp: resolveMcpOptions(input.mcp),
    hashline_edit: input.hashline_edit,
    memory_enabled: input.memory_enabled,
    memory_dream: input.memory_dream,
    goal_enabled: input.goal_enabled,
    command_tool_enabled: input.command_tool_enabled,
    tool_guards: input.tool_guards,
    preemptive_compaction: input.preemptive_compaction,
    os_notifications: input.os_notifications,
    model_fallback: input.model_fallback,
    proactive_model_fallback: input.proactive_model_fallback,
    teams: input.teams,
    lsp: input.lsp,
    terminal: input.terminal,
    telemetry: input.telemetry,
  }
}
