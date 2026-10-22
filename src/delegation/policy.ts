import type { ResolvedOptions } from "../config/resolve.js"
import { FIXED_CATEGORIES, sameModel } from "../config/schema.js"
import type { DelegationPolicy, DelegationRequest, ModelRef } from "../contracts.js"
import { type SkillCatalogEntry, selectSkills } from "./skills.js"

export type DelegationCatalog = {
  agents: readonly { id: string; mode: "subagent" | "primary" | "all" }[]
  models: readonly ModelRef[]
  skills: readonly SkillCatalogEntry[]
  recommendSkills?: (request: DelegationRequest) => readonly string[]
}

const DEFAULT_AGENTS: Record<string, string> = {
  investigate: "explore",
  implement: "executor",
  review: "reviewer",
  document: "executor",
  validate: "verifier",
}

class DelegationPolicyError extends Error {
  constructor(
    readonly code:
      | "unknown-category"
      | "unknown-agent"
      | "primary-agent"
      | "invalid-model"
      | "disallowed-model",
    message: string,
  ) {
    super(message)
    this.name = "DelegationPolicyError"
  }
}

export function createDelegationPolicy(
  options: ResolvedOptions,
  catalog: DelegationCatalog,
): DelegationPolicy {
  const formatModel = (model: ModelRef) =>
    `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
  const summarize = (models: readonly ModelRef[], limit = 8) => {
    const shown = models.slice(0, limit).map(formatModel)
    return models.length > limit
      ? `${shown.join(", ")} (+${models.length - limit} more)`
      : shown.join(", ") || "(none)"
  }
  return {
    resolve(request) {
      if (
        request.route.kind === "category" &&
        !FIXED_CATEGORIES.some((id) => id === request.route.id)
      ) {
        throw new DelegationPolicyError("unknown-category", `unknown category: ${request.route.id}`)
      }
      const category =
        request.route.kind === "category"
          ? options.categories.find((entry) => entry.id === request.route.id)
          : undefined
      let agentID: string
      if (request.route.kind === "agent") {
        agentID = request.route.id
      } else {
        const fallback = category?.agent ?? DEFAULT_AGENTS[request.route.id]
        if (!fallback)
          throw new DelegationPolicyError(
            "unknown-category",
            `unknown category: ${request.route.id}`,
          )
        agentID = fallback
      }
      const agent = catalog.agents.find((entry) => entry.id === agentID)
      if (!agent) throw new DelegationPolicyError("unknown-agent", `unknown agent: ${agentID}`)
      if (agent.mode === "primary")
        throw new DelegationPolicyError("primary-agent", `primary-only agent: ${agentID}`)
      const profile = options.profiles.find((entry) => entry.id === agentID)
      const model = request.explicitModel ?? category?.model ?? profile?.model
      if (
        model &&
        options.allowedModels &&
        !options.allowedModels.some((entry) => sameModel(entry, model))
      ) {
        throw new DelegationPolicyError(
          "disallowed-model",
          `model not permitted: ${formatModel(model)}; permitted by allowedModels: ${summarize(options.allowedModels)}`,
        )
      }
      if (
        model &&
        profile?.allowedModels &&
        !profile.allowedModels.some((entry) => sameModel(entry, model))
      ) {
        throw new DelegationPolicyError(
          "disallowed-model",
          `model not permitted for agent ${agentID}: ${formatModel(model)}; permitted for ${agentID}: ${summarize(profile.allowedModels)}`,
        )
      }
      if (
        model &&
        !catalog.models.some(
          (entry) =>
            entry.providerID === model.providerID &&
            entry.modelID === model.modelID &&
            (!model.variant || entry.variant === model.variant),
        )
      ) {
        throw new DelegationPolicyError(
          "invalid-model",
          `model unavailable: ${formatModel(model)}; host offers: ${summarize(catalog.models)}`,
        )
      }
      return {
        agentID,
        ...(model ? { model: { ...model } } : {}),
        skills: selectSkills(
          request.skills,
          options.skills.required,
          options.skills.auto ? (catalog.recommendSkills?.(request) ?? []) : [],
          catalog.skills,
          options.skills.recommendedLimit,
        ),
        prompt: request.prompt,
        background: request.background,
        ...(request.sessionID !== undefined ? { sessionID: request.sessionID } : {}),
      }
    },
  }
}
