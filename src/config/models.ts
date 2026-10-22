import type { ModelRef } from "../contracts"
import { type OmoOptions, OptionsError, sameModel } from "./schema"

type AgentModelPolicy = Pick<OmoOptions, "allowedModels" | "profiles">

/** Check the effective model (including resolved host defaults), never substitute it. */
export function assertAgentModelAllowed(
  options: AgentModelPolicy,
  agentID: string,
  model: ModelRef,
  path = "model",
): void {
  const agent = options.profiles.find((profile) => profile.id === agentID)
  for (const [label, allowed] of [
    ["global", options.allowedModels],
    [`agent ${agentID}`, agent?.allowedModels],
  ] as const) {
    if (allowed !== undefined && !allowed.some((candidate) => sameModel(candidate, model))) {
      throw new OptionsError(path, `model or variant is not permitted by ${label} allowedModels`)
    }
  }
}

/** An omitted catalog defers availability to the host; an empty catalog permits none. */
export function validateConfiguredModels(
  options: OmoOptions,
  availableModels?: readonly ModelRef[],
): void {
  if (!availableModels) return
  for (const [section, entries] of [
    ["profiles", options.profiles],
    ["categories", options.categories],
  ] as const) {
    for (const [index, entry] of entries.entries()) {
      const wanted = entry.model
      if (wanted && !availableModels.some((model) => sameModel(model, wanted))) {
        throw new OptionsError(
          `${section}[${index}].model`,
          "model or variant is unavailable in the supplied host catalog",
        )
      }
    }
  }
  for (const [index, model] of (options.allowedModels ?? []).entries()) {
    if (!availableModels.some((available) => sameModel(available, model)))
      throw new OptionsError(
        `allowedModels[${index}]`,
        "allowed model is unavailable in the supplied host catalog",
      )
  }
  for (const [profileIndex, profile] of options.profiles.entries()) {
    for (const [modelIndex, model] of (profile.allowedModels ?? []).entries()) {
      if (!availableModels.some((available) => sameModel(available, model))) {
        throw new OptionsError(
          `profiles[${profileIndex}].allowedModels[${modelIndex}]`,
          "allowed agent model or variant is unavailable in the supplied host catalog",
        )
      }
    }
  }
}
