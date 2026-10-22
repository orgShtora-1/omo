import { profiles as builtinProfiles } from "../agents/prompts"
import {
  DEFAULT_PREEMPTIVE_COMPACTION,
  type PreemptiveCompactionConfig,
} from "../context/compaction"
import type { ModelRef } from "../contracts"
import { DEFAULT_OS_NOTIFICATIONS, type OsNotificationsConfig } from "../execution/os-notifications"
import { type McpOptions, parseMcpOptions } from "../mcp/config"
import { DEFAULT_DREAM_CONFIG, type DreamConfig } from "../memory/dream"
import {
  DEFAULT_MODEL_FALLBACK,
  fallbackCandidatePermitted,
  type ModelFallbackConfig,
} from "./model-fallback"

// Opções do plugin @shtora/omo: fonte principal de configuração.
// parseOptions valida input desconhecido e devolve OmoOptions normalizado;
// resolveOptions (resolve.ts) aplica os defaults exatos da spec.
// Decisões: chaves top-level desconhecidas são rejeitadas (compatibilidade
// futura via bump de schemaVersion, que rejeita versão > 1); categorias são
// as 5 fixas da spec; category.agent referencia um profile do mesmo documento.

const SCHEMA_VERSION = 1 as const

export const FIXED_CATEGORIES = [
  "investigate",
  "implement",
  "review",
  "document",
  "validate",
] as const

type CategoryID = (typeof FIXED_CATEGORIES)[number]

export type ProfileConfig = {
  id: string
  mode: "primary" | "subagent" | "all"
  allowWrite: boolean
  model?: ModelRef
  allowedModels?: ModelRef[]
}

export type CategoryConfig = {
  id: CategoryID
  agent: string
  model?: ModelRef
}

type ExecutionConfig = {
  maxChildren?: number
  timeoutMs?: number
  foregroundTimeoutMs?: number
  backgroundTimeoutMs?: number
  /** Upper bound a queued delegation may wait for a capacity slot before failing. */
  admissionTimeoutMs?: number
  /** A running child with no observable host update for this long is cancelled and failed. */
  staleTimeoutMs?: number
  providerLimits?: Record<string, number>
  modelLimits?: Record<string, number>
  verifyArtifacts?: boolean
  maxRetries?: number
  maxAttempts?: number
  fallback?: boolean
  maxDepth?: number
}

type SkillsConfig = {
  recommendedLimit?: number
  auto?: boolean
  required?: string[]
  autoInstall?: boolean
  requireAuditPass?: boolean
  strictAudits?: boolean
}

// Runtime preference: which package manager OmO always uses for the commands
// it shells out (today the skills auto-installer and the doctor remediation).
const PACKAGE_MANAGERS = ["npm", "bun", "yarn", "pnpm"] as const
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]

type RuntimeConfig = {
  packageManager?: PackageManager
}

// Guardas de leitura/escrita por nome de tool (opção `tool_guards`).
// `write`/`read` são listas de padrões de nome: nome exato ("edit") ou
// coringa simples de sufixo ("omo_*"; "*" sozinho casa com tudo).
export type ToolGuardsConfig = {
  enabled: boolean
  write: string[]
  read: string[]
}

export type OmoOptions = {
  schemaVersion: typeof SCHEMA_VERSION
  profiles: ProfileConfig[]
  categories: CategoryConfig[]
  execution: ExecutionConfig
  skills: SkillsConfig
  runtime: RuntimeConfig
  mcp: McpOptions
  hashline_edit: boolean
  memory_enabled: boolean
  memory_dream: DreamConfig
  goal_enabled: boolean
  command_tool_enabled: boolean
  tool_guards: ToolGuardsConfig
  preemptive_compaction: PreemptiveCompactionConfig
  os_notifications: OsNotificationsConfig
  model_fallback: ModelFallbackConfig
  allowedModels?: ModelRef[]
  teams?: Record<string, unknown>
  lsp?: Record<string, unknown>
  terminal?: Record<string, unknown>
  telemetry?: Record<string, unknown>
}

// Erro tipado de validação. Contrato: `path` é o caminho do campo
// (ex. "execution.maxChildren", "profiles[1].id", "(root)").
export class OptionsError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = "OptionsError"
    this.path = path
  }
}

function fail(path: string, message: string): never {
  throw new OptionsError(path, message)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "esperava string não vazia")
  return value as string
}

function optionalModel(value: unknown, path: string): ModelRef | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") {
    const match = /^([^\s/#]+)\/([^\s#]+)(?:#([^\s#]+))?$/.exec(value)
    if (!match) fail(path, "esperava provider/model#variant")
    const [, providerID, modelID, variant] = match
    if (!providerID || !modelID) fail(path, "esperava provider/model#variant")
    return { providerID, modelID, ...(variant ? { variant } : {}) }
  }
  if (!isRecord(value)) fail(path, "esperava objeto { providerID, modelID, variant? }")
  const model: ModelRef = {
    providerID: nonEmptyString(value.providerID, `${path}.providerID`),
    modelID: nonEmptyString(value.modelID, `${path}.modelID`),
  }
  if (value.variant !== undefined) model.variant = nonEmptyString(value.variant, `${path}.variant`)
  return model
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") fail(path, "esperava boolean")
  return value
}

function optionalAllowedModels(value: unknown, path: string): ModelRef[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail(path, "esperava array de modelos")
  return value.map(
    (model, index) =>
      optionalModel(model, `${path}[${index}]`) ?? fail(`${path}[${index}]`, "modelo obrigatório"),
  )
}

function validateDefaultModel(
  model: ModelRef | undefined,
  allowed: ModelRef[] | undefined,
  path: string,
): void {
  if (model && allowed && !allowed.some((candidate) => sameModel(candidate, model)))
    fail(path, "modelo não permitido por allowedModels do agente")
}

function optionalSection(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail(path, "esperava objeto")
  return value
}

function parseProfiles(value: unknown): ProfileConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail("profiles", "esperava array")
  const seen = new Set<string>()
  return (value as unknown[]).map((entry, i) => {
    const path = `profiles[${i}]`
    if (!isRecord(entry)) fail(path, "esperava objeto")
    const id = nonEmptyString(entry.id, `${path}.id`)
    if (seen.has(id)) fail(`${path}.id`, `perfil duplicado: ${id}`)
    seen.add(id)
    const mode = entry.mode === undefined ? "subagent" : entry.mode
    if (mode !== "subagent" && mode !== "primary" && mode !== "all")
      fail(`${path}.mode`, "esperava primary, subagent ou all")
    const model = optionalModel(entry.model, `${path}.model`)
    const allowedModels = optionalAllowedModels(entry.allowedModels, `${path}.allowedModels`)
    validateDefaultModel(model, allowedModels, `${path}.model`)
    return {
      id,
      mode,
      allowWrite: optionalBoolean(entry.allowWrite, `${path}.allowWrite`) ?? false,
      model,
      ...(allowedModels !== undefined ? { allowedModels } : {}),
    }
  })
}

function parseCategories(value: unknown, profileIDs: Set<string>): CategoryConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail("categories", "esperava array")
  const seen = new Set<string>()
  return (value as unknown[]).map((entry, i) => {
    const path = `categories[${i}]`
    if (!isRecord(entry)) fail(path, "esperava objeto")
    const id = nonEmptyString(entry.id, `${path}.id`)
    if (!(FIXED_CATEGORIES as readonly string[]).includes(id)) {
      fail(`${path}.id`, `categoria desconhecida: ${id}`)
    }
    if (seen.has(id)) fail(`${path}.id`, `categoria duplicada: ${id}`)
    seen.add(id)
    const agent = nonEmptyString(entry.agent, `${path}.agent`)
    if (!profileIDs.has(agent)) fail(`${path}.agent`, `perfil inexistente: ${agent}`)
    return { id: id as CategoryID, agent, model: optionalModel(entry.model, `${path}.model`) }
  })
}

function optionalPositiveInt(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) <= 0) {
    fail(path, "esperava inteiro positivo")
  }
  return value as number
}

function optionalNonNegativeInt(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) < 0) {
    fail(path, "esperava inteiro >= 0")
  }
  return value as number
}

// Limiares das opções novas (compactação preemptiva, notificações OS): além de
// inteiros positivos, devem ser safe integers — um limiar acima de 2^53 não é
// representável com segurança e é rejeitado na validação, não silenciosamente.
function optionalSafePositiveInt(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(path, "esperava inteiro positivo")
  }
  return value as number
}

function optionalLimits(value: unknown, path: string): Record<string, number> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail(path, "esperava objeto")
  return Object.fromEntries(
    Object.entries(value).map(([key, limit]) => [
      key,
      optionalPositiveInt(limit, `${path}.${key}`) ??
        fail(`${path}.${key}`, "esperava inteiro positivo"),
    ]),
  )
}

function parseExecution(value: unknown): ExecutionConfig {
  if (value === undefined) return {}
  if (!isRecord(value)) fail("execution", "esperava objeto")
  const execution: ExecutionConfig = {
    maxChildren: optionalPositiveInt(value.maxChildren, "execution.maxChildren"),
    timeoutMs: optionalPositiveInt(value.timeoutMs, "execution.timeoutMs"),
    foregroundTimeoutMs: optionalPositiveInt(
      value.foregroundTimeoutMs,
      "execution.foregroundTimeoutMs",
    ),
    backgroundTimeoutMs: optionalPositiveInt(
      value.backgroundTimeoutMs,
      "execution.backgroundTimeoutMs",
    ),
    admissionTimeoutMs: optionalPositiveInt(
      value.admissionTimeoutMs,
      "execution.admissionTimeoutMs",
    ),
    staleTimeoutMs: optionalPositiveInt(value.staleTimeoutMs, "execution.staleTimeoutMs"),
    providerLimits: optionalLimits(value.providerLimits, "execution.providerLimits"),
    modelLimits: optionalLimits(value.modelLimits, "execution.modelLimits"),
    verifyArtifacts: optionalBoolean(value.verifyArtifacts, "execution.verifyArtifacts"),
    maxRetries: optionalNonNegativeInt(value.maxRetries, "execution.maxRetries"),
    maxAttempts: optionalPositiveInt(value.maxAttempts, "execution.maxAttempts"),
    fallback: optionalBoolean(value.fallback, "execution.fallback"),
    maxDepth: optionalPositiveInt(value.maxDepth, "execution.maxDepth"),
  }
  if (
    execution.maxRetries !== undefined &&
    execution.maxAttempts !== undefined &&
    execution.maxAttempts < execution.maxRetries + 1
  ) {
    fail("execution.maxAttempts", "precisa cobrir tentativa inicial + retries")
  }
  return execution
}

function parseSkills(value: unknown): SkillsConfig {
  if (value === undefined) return {}
  if (!isRecord(value)) fail("skills", "esperava objeto")
  let required: string[] | undefined
  if (value.required !== undefined) {
    if (!Array.isArray(value.required)) fail("skills.required", "esperava array de strings")
    required = (value.required as unknown[]).map((s, i) =>
      nonEmptyString(s, `skills.required[${i}]`),
    )
  }
  return {
    recommendedLimit: optionalPositiveInt(value.recommendedLimit, "skills.recommendedLimit"),
    auto: optionalBoolean(value.auto, "skills.auto"),
    autoInstall: optionalBoolean(value.autoInstall, "skills.autoInstall"),
    requireAuditPass: optionalBoolean(value.requireAuditPass, "skills.requireAuditPass"),
    strictAudits: optionalBoolean(value.strictAudits, "skills.strictAudits"),
    required,
  }
}

function parseRuntime(value: unknown): RuntimeConfig {
  if (value === undefined) return {}
  if (!isRecord(value)) fail("runtime", "esperava objeto")
  for (const key of Object.keys(value))
    if (key !== "packageManager") fail(`runtime.${key}`, "campo desconhecido")
  if (value.packageManager === undefined) return {}
  if (
    typeof value.packageManager !== "string" ||
    !(PACKAGE_MANAGERS as readonly string[]).includes(value.packageManager)
  ) {
    fail("runtime.packageManager", `esperava um de: ${PACKAGE_MANAGERS.join(", ")}`)
  }
  return { packageManager: value.packageManager as PackageManager }
}

// Política do gatilho sonho/tempo: campos conhecidos apenas, inteiros
// positivos, defaults exatos da spec aplicados quando ausentes. Chave
// desconhecida é rejeitada — uma opção de sonho pela metade não pode existir.
function parseMemoryDream(value: unknown, path: string): DreamConfig {
  if (value === undefined) return { ...DEFAULT_DREAM_CONFIG }
  if (!isRecord(value)) fail(path, "esperava objeto")
  for (const key of Object.keys(value))
    if (!["enabled", "idleMinutes", "minHoursBetween"].includes(key))
      fail(`${path}.${key}`, "campo desconhecido")
  return {
    enabled: optionalBoolean(value.enabled, `${path}.enabled`) ?? DEFAULT_DREAM_CONFIG.enabled,
    idleMinutes:
      optionalPositiveInt(value.idleMinutes, `${path}.idleMinutes`) ??
      DEFAULT_DREAM_CONFIG.idleMinutes,
    minHoursBetween:
      optionalPositiveInt(value.minHoursBetween, `${path}.minHoursBetween`) ??
      DEFAULT_DREAM_CONFIG.minHoursBetween,
  }
}

// Lista de padrões de nome de tool da guarda: cada entrada é um nome exato
// ("edit") ou um coringa simples de sufixo ("omo_*"); "*" sozinho casa com
// todas. "*" em qualquer outra posição, entrada vazia e espaços nas bordas
// são rejeitados — um padrão que nunca casa é erro de configuração, não um
// silêncio aceitável.
function parseToolPatterns(value: unknown, path: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(path, "esperava array de strings")
  return (value as unknown[]).map((entry, i) => {
    const at = `${path}[${i}]`
    if (typeof entry !== "string" || !entry.trim()) fail(at, "esperava string não vazia")
    if (entry !== entry.trim()) fail(at, "padrão não pode ter espaços nas bordas")
    const star = entry.indexOf("*")
    if (star !== -1 && star !== entry.length - 1)
      fail(at, "curinga '*' só é aceito no fim do padrão")
    return entry
  })
}

// Política das guardas de leitura/escrita: campos conhecidos apenas,
// `enabled` booleano (default desligado) e listas validadas padrão a padrão.
// Chave desconhecida é rejeitada — uma guarda pela metade não pode existir.
function parseToolGuards(value: unknown, path: string): ToolGuardsConfig {
  if (value === undefined) return { enabled: false, write: [], read: [] }
  if (!isRecord(value)) fail(path, "esperava objeto")
  for (const key of Object.keys(value))
    if (!["enabled", "write", "read"].includes(key)) fail(`${path}.${key}`, "campo desconhecido")
  return {
    enabled: optionalBoolean(value.enabled, `${path}.enabled`) ?? false,
    write: parseToolPatterns(value.write, `${path}.write`),
    read: parseToolPatterns(value.read, `${path}.read`),
  }
}

// Política da compactação preemptiva (opção `preemptive_compaction`): o hook
// de contexto existente mede o contexto construído e pede ao host no máximo uma
// compactação por janela de cooldown, com guarda pura por sessão. Campos
// conhecidos apenas; default desligado.
function parsePreemptiveCompaction(value: unknown, path: string): PreemptiveCompactionConfig {
  if (value === undefined) return { ...DEFAULT_PREEMPTIVE_COMPACTION }
  if (!isRecord(value)) fail(path, "esperava objeto")
  for (const key of Object.keys(value))
    if (!["enabled", "thresholdChars", "cooldownMs"].includes(key))
      fail(`${path}.${key}`, "campo desconhecido")
  return {
    enabled: optionalBoolean(value.enabled, `${path}.enabled`) ?? false,
    thresholdChars:
      optionalSafePositiveInt(value.thresholdChars, `${path}.thresholdChars`) ??
      DEFAULT_PREEMPTIVE_COMPACTION.thresholdChars,
    cooldownMs:
      optionalSafePositiveInt(value.cooldownMs, `${path}.cooldownMs`) ??
      DEFAULT_PREEMPTIVE_COMPACTION.cooldownMs,
  }
}

// Política das notificações OS (opção `os_notifications`): espelha no sistema
// operacional os mesmos eventos de execução que o notifier in-app publica.
// Campos conhecidos apenas; default desligado.
function parseOsNotifications(value: unknown, path: string): OsNotificationsConfig {
  if (value === undefined) return { ...DEFAULT_OS_NOTIFICATIONS }
  if (!isRecord(value)) fail(path, "esperava objeto")
  for (const key of Object.keys(value))
    if (!["enabled", "timeoutMs"].includes(key)) fail(`${path}.${key}`, "campo desconhecido")
  return {
    enabled: optionalBoolean(value.enabled, `${path}.enabled`) ?? false,
    timeoutMs:
      optionalSafePositiveInt(value.timeoutMs, `${path}.timeoutMs`) ??
      DEFAULT_OS_NOTIFICATIONS.timeoutMs,
  }
}

// Política do fallback reativo de modelo (opção `model_fallback`): cadeias
// ordenadas por perfil aplicadas no hook público `session.hook("retry")`,
// sempre dentro das allowlists que o hook `model.request` já aplica. Campos
// conhecidos apenas; default desligado (sem hook algum registrado).
function parseModelFallback(
  value: unknown,
  path: string,
  profileIDs: ReadonlySet<string>,
  allowedModels: ModelRef[] | undefined,
  profiles: ProfileConfig[],
): ModelFallbackConfig {
  if (value === undefined) return { ...DEFAULT_MODEL_FALLBACK, profiles: {} }
  if (!isRecord(value)) fail(path, "esperava objeto")
  for (const key of Object.keys(value))
    if (!["enabled", "delayMs", "maxAttempts", "profiles"].includes(key))
      fail(`${path}.${key}`, "campo desconhecido")
  const chains: Record<string, ModelRef[]> = {}
  if (value.profiles !== undefined) {
    if (!isRecord(value.profiles)) fail(`${path}.profiles`, "esperava objeto por ID de perfil")
    for (const [id, chain] of Object.entries(value.profiles)) {
      const at = `${path}.profiles.${id}`
      if (!profileIDs.has(id)) fail(at, `perfil inexistente: ${id}`)
      if (!Array.isArray(chain) || chain.length === 0)
        fail(at, "esperava array não vazio de modelos")
      const parsed = chain.map(
        (model, index) =>
          optionalModel(model, `${at}[${index}]`) ?? fail(`${at}[${index}]`, "modelo obrigatório"),
      )
      for (const [index, model] of parsed.entries()) {
        if (parsed.slice(0, index).some((seen) => sameModel(seen, model)))
          fail(`${at}[${index}]`, "modelo duplicado na cadeia de fallback")
        // Fail-closed no carregamento: uma cadeia fora das allowlists é erro
        // de configuração, não um candidato a pular em silêncio no runtime.
        if (!fallbackCandidatePermitted({ allowedModels, profiles }, id, model))
          fail(`${at}[${index}]`, "modelo não permitido por allowedModels")
      }
      chains[id] = parsed
    }
  }
  const config: ModelFallbackConfig = {
    enabled: optionalBoolean(value.enabled, `${path}.enabled`) ?? false,
    delayMs:
      optionalSafePositiveInt(value.delayMs, `${path}.delayMs`) ?? DEFAULT_MODEL_FALLBACK.delayMs,
    maxAttempts:
      optionalSafePositiveInt(value.maxAttempts, `${path}.maxAttempts`) ??
      DEFAULT_MODEL_FALLBACK.maxAttempts,
    profiles: chains,
  }
  if (config.enabled && Object.keys(chains).length === 0)
    fail(`${path}.enabled`, "fallback habilitado sem cadeias em profiles")
  return config
}

const KNOWN_TOP_LEVEL = new Set([
  "schemaVersion",
  "profiles",
  "categories",
  "execution",
  "skills",
  "runtime",
  "mcp",
  "hashline_edit",
  "memory_enabled",
  "memory_dream",
  "goal_enabled",
  "command_tool_enabled",
  "tool_guards",
  "preemptive_compaction",
  "os_notifications",
  "model_fallback",
  "teams",
  "lsp",
  "terminal",
  "telemetry",
  "agents",
  "allowedModels",
  "$schema",
])

export function parseOptions(input: unknown): OmoOptions {
  if (!isRecord(input)) fail("(root)", "esperava objeto de opções")
  for (const key of Object.keys(input)) {
    if (!KNOWN_TOP_LEVEL.has(key)) fail(key, "campo desconhecido")
  }
  if (input.schemaVersion === undefined) fail("schemaVersion", "campo obrigatório")
  if (input.schemaVersion !== SCHEMA_VERSION) {
    fail(
      "schemaVersion",
      typeof input.schemaVersion === "number" && input.schemaVersion > SCHEMA_VERSION
        ? `versão futura não suportada: ${input.schemaVersion}`
        : `esperava schemaVersion ${SCHEMA_VERSION}`,
    )
  }
  const profiles = parseProfiles(input.profiles)
  if (input.agents !== undefined) {
    if (!isRecord(input.agents)) fail("agents", "esperava objeto por ID de agente")
    for (const [id, entry] of Object.entries(input.agents)) {
      const path = `agents.${id}`
      const builtin = builtinProfiles.find((p) => p.id === id)
      if (!builtin) fail(path, "agente desconhecido; use profiles para perfis customizados")
      if (!isRecord(entry)) fail(path, "esperava objeto")
      for (const key of Object.keys(entry))
        if (!["mode", "allowWrite", "model", "allowedModels"].includes(key))
          fail(`${path}.${key}`, "campo desconhecido")
      if (profiles.some((p) => p.id === id))
        fail(path, "não configure o mesmo ID em agents e profiles")
      const mode = entry.mode ?? builtin.mode
      if (mode !== "primary" && mode !== "subagent" && mode !== "all")
        fail(`${path}.mode`, "esperava primary, subagent ou all")
      const model = optionalModel(entry.model, `${path}.model`)
      const allowedModels = optionalAllowedModels(entry.allowedModels, `${path}.allowedModels`)
      validateDefaultModel(model, allowedModels, `${path}.model`)
      profiles.push({
        id,
        mode,
        allowWrite: optionalBoolean(entry.allowWrite, `${path}.allowWrite`) ?? builtin.write,
        model,
        ...(allowedModels !== undefined ? { allowedModels } : {}),
      })
    }
  }
  let allowedModels: ModelRef[] | undefined
  if (input.allowedModels !== undefined) {
    if (!Array.isArray(input.allowedModels)) fail("allowedModels", "esperava array de modelos")
    allowedModels = input.allowedModels.map((model, index) => {
      const path = `allowedModels[${index}]`
      return optionalModel(model, path) ?? fail(path, "modelo obrigatório")
    })
    for (const [index, profile] of profiles.entries()) {
      const wanted = profile.model
      if (wanted && !allowedModels.some((model) => sameModel(model, wanted)))
        fail(`profiles[${index}].model`, "modelo não permitido por allowedModels")
    }
  }
  const profileIDs = new Set([...builtinProfiles.map((p) => p.id), ...profiles.map((p) => p.id)])
  const categories = parseCategories(input.categories, profileIDs)
  for (const [index, category] of categories.entries()) {
    validateDefaultModel(
      category.model,
      profiles.find((profile) => profile.id === category.agent)?.allowedModels,
      `categories[${index}].model`,
    )
  }
  if (allowedModels)
    for (const [index, category] of categories.entries()) {
      const wanted = category.model
      if (wanted && !allowedModels.some((model) => sameModel(model, wanted)))
        fail(`categories[${index}].model`, "modelo não permitido por allowedModels")
    }
  const model_fallback = parseModelFallback(
    input.model_fallback,
    "model_fallback",
    profileIDs,
    allowedModels,
    profiles,
  )
  return {
    schemaVersion: SCHEMA_VERSION,
    profiles,
    categories,
    allowedModels,
    execution: parseExecution(input.execution),
    skills: parseSkills(input.skills),
    runtime: parseRuntime(input.runtime),
    mcp: parseMcpOptions(input.mcp, fail),
    hashline_edit: optionalBoolean(input.hashline_edit, "hashline_edit") ?? false,
    memory_enabled: optionalBoolean(input.memory_enabled, "memory_enabled") ?? false,
    memory_dream: parseMemoryDream(input.memory_dream, "memory_dream"),
    goal_enabled: optionalBoolean(input.goal_enabled, "goal_enabled") ?? false,
    command_tool_enabled:
      optionalBoolean(input.command_tool_enabled, "command_tool_enabled") ?? false,
    tool_guards: parseToolGuards(input.tool_guards, "tool_guards"),
    preemptive_compaction: parsePreemptiveCompaction(
      input.preemptive_compaction,
      "preemptive_compaction",
    ),
    os_notifications: parseOsNotifications(input.os_notifications, "os_notifications"),
    model_fallback,
    teams: optionalSection(input.teams, "teams"),
    lsp: optionalSection(input.lsp, "lsp"),
    terminal: optionalSection(input.terminal, "terminal"),
    telemetry: optionalSection(input.telemetry, "telemetry"),
  }
}

export function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant
}
