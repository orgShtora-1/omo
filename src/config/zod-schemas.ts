/**
 * Zod v4 schemas for @shtora/omo configuration validation.
 * These schemas handle primitive validation; cross-field validation
 * (profile references, allowedModels, agent/category checks) remains
 * in schema.ts for full backward compatibility.
 */

import { z } from "zod"
import type { ModelRef } from "../contracts.js"
import type { McpOptions } from "../mcp/config.js"

export const SCHEMA_VERSION = 1 as const

// Base primitive schemas

const NonEmptyStringSchema = z.string().min(1)

const PositiveIntSchema = z.number().int().positive()
const NonNegativeIntSchema = z.number().int().nonnegative()
const SafePositiveIntSchema = z.number().int().positive().finite()
const SafePositiveFloatSchema = z.number().finite().positive().max(1)

// ModelRef schema - handles both string and object formats
const ModelRefSchema: z.ZodType<ModelRef> = z.union([
  z.string().transform((value, ctx) => {
    const match = /^([^\s/#]+)\/([^\s#]+)(?:#([^\s#]+))?$/.exec(value)
    if (!match) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "esperava provider/model#variant" })
      return z.NEVER
    }
    const [, providerID, modelID, variant] = match
    if (!providerID || !modelID) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "esperava provider/model#variant" })
      return z.NEVER
    }
    return { providerID, modelID, ...(variant ? { variant } : {}) }
  }),
  z.object({
    providerID: NonEmptyStringSchema,
    modelID: NonEmptyStringSchema,
    variant: NonEmptyStringSchema.optional(),
  }),
])

// Profile schema (without cross-validation)
const ProfileConfigSchema = z.object({
  id: NonEmptyStringSchema,
  mode: z.enum(["primary", "subagent", "all"]).default("subagent"),
  allowWrite: z.boolean().default(false),
  model: ModelRefSchema.optional(),
  allowedModels: z.array(ModelRefSchema).optional(),
  thinkMode: z.boolean().optional(),
})

// Category schema (without cross-validation)
const CategoryConfigSchema = z.object({
  id: z.enum(["investigate", "implement", "review", "document", "validate"]),
  agent: NonEmptyStringSchema,
  model: ModelRefSchema.optional(),
})

// Execution config schema
const ExecutionConfigSchema = z.object({
  maxChildren: PositiveIntSchema.optional(),
  timeoutMs: PositiveIntSchema.optional(),
  foregroundTimeoutMs: PositiveIntSchema.optional(),
  backgroundTimeoutMs: PositiveIntSchema.optional(),
  admissionTimeoutMs: PositiveIntSchema.optional(),
  staleTimeoutMs: PositiveIntSchema.optional(),
  providerLimits: z.record(z.string(), PositiveIntSchema).optional(),
  modelLimits: z.record(z.string(), PositiveIntSchema).optional(),
  verifyArtifacts: z.boolean().optional(),
  maxRetries: NonNegativeIntSchema.optional(),
  maxAttempts: PositiveIntSchema.optional(),
  fallback: z.boolean().optional(),
  maxDepth: PositiveIntSchema.optional(),
})

// Skills config schema
const SkillsConfigSchema = z.object({
  recommendedLimit: PositiveIntSchema.optional(),
  auto: z.boolean().optional(),
  required: z.array(NonEmptyStringSchema).optional(),
  autoInstall: z.boolean().optional(),
  requireAuditPass: z.boolean().optional(),
  strictAudits: z.boolean().optional(),
})

// Runtime config schema
const PACKAGE_MANAGERS = ["npm", "bun", "yarn", "pnpm"] as const
const RuntimeConfigSchema = z.object({
  packageManager: z.enum(PACKAGE_MANAGERS).optional(),
})

// Tool pattern schema
const ToolPatternSchema = z.string().superRefine((pattern, ctx) => {
  if (!pattern.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "esperava string não vazia" })
    return
  }
  if (pattern !== pattern.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "padrão não pode ter espaços nas bordas" })
    return
  }
  const star = pattern.indexOf("*")
  if (star !== -1 && star !== pattern.length - 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "curinga '*' só é aceito no fim do padrão",
    })
  }
})

// Tool guards schema
const ToolGuardsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    write: z.array(ToolPatternSchema).default(() => []),
    read: z.array(ToolPatternSchema).default(() => []),
    writeGuard: z.object({ enabled: z.boolean().default(false) }).optional(),
  })
  .default({ enabled: false, write: [], read: [] })

// Top-level options schema (without cross-validation)
export const OmoOptionsSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  profiles: z.array(ProfileConfigSchema).default(() => []),
  categories: z.array(CategoryConfigSchema).default(() => []),
  execution: ExecutionConfigSchema.default(() => ({})),
  skills: SkillsConfigSchema.default(() => ({})),
  runtime: RuntimeConfigSchema.default(() => ({})),
  mcp: z.custom<McpOptions>().optional(),
  hashline_edit: z.boolean().default(false),
  memory_enabled: z.boolean().default(false),
  memory_dream: z
    .object({
      enabled: z.boolean().optional(),
      idleMinutes: PositiveIntSchema.optional(),
      minHoursBetween: PositiveIntSchema.optional(),
    })
    .default({ enabled: false, idleMinutes: 30, minHoursBetween: 24 }),
  goal_enabled: z.boolean().default(false),
  command_tool_enabled: z.boolean().default(false),
  tool_guards: ToolGuardsConfigSchema.default({ enabled: false, write: [], read: [] }),
  preemptive_compaction: z
    .object({
      enabled: z.boolean().optional(),
      thresholdChars: SafePositiveIntSchema.optional(),
      cooldownMs: SafePositiveIntSchema.optional(),
    })
    .default({ enabled: false, thresholdChars: 120000, cooldownMs: 60000 }),
  os_notifications: z
    .object({
      enabled: z.boolean().optional(),
      timeoutMs: SafePositiveIntSchema.optional(),
    })
    .default({ enabled: false, timeoutMs: 10000 }),
  model_fallback: z
    .object({
      enabled: z.boolean().optional(),
      delayMs: SafePositiveIntSchema.optional(),
      maxAttempts: SafePositiveIntSchema.optional(),
      profiles: z.record(z.string(), z.array(ModelRefSchema).min(1)).optional(),
    })
    .default({ enabled: false, delayMs: 1000, maxAttempts: 3, profiles: {} }),
  proactive_model_fallback: z
    .object({
      enabled: z.boolean().optional(),
      triggerPct: SafePositiveFloatSchema.optional(),
      cooldownMs: SafePositiveIntSchema.optional(),
    })
    .default({ enabled: false, triggerPct: 0.9, cooldownMs: 30000 }),
  allowedModels: z.array(ModelRefSchema).optional(),
  teams: z.record(z.string(), z.unknown()).optional(),
  lsp: z.record(z.string(), z.unknown()).optional(),
  terminal: z.record(z.string(), z.unknown()).optional(),
  telemetry: z.record(z.string(), z.unknown()).optional(),
  agents: z.record(z.string(), z.unknown()).optional(),
  $schema: z.string().optional(),
})
