import { Model, type Plugin } from "@opencode/plugin"
import { assertAgentModelAllowed } from "../config/models"
import type { ResolvedOptions } from "../config/resolve"
import { OmoError } from "../errors/base.js"
import { type AgentRestriction, profiles } from "./prompts"

// V2 exposes no origin marker. Only augment the exact standard host role;
// customized or independently registered profiles still fail collision checks.
const hostExploreDescription =
  'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.'

const CONSULT_DENY_MESSAGE =
  "omo consultation profiles deny shell and edits. Delegate execution to an authorized executor."

type Rule = { action: string; resource: string; effect: "deny" | "allow" }

function restrictionRules(restriction: AgentRestriction): Rule[] {
  switch (restriction.kind) {
    case "deny-actions":
      return [
        ...(restriction.allow ?? []).map((action) => ({
          action,
          resource: "*",
          effect: "allow" as const,
        })),
        ...restriction.actions.map((action) => ({
          action,
          resource: "*",
          effect: "deny" as const,
        })),
      ]
    case "allow-only":
      return [
        { action: "*", resource: "*", effect: "deny" as const },
        ...restriction.actions.map((action) => ({
          action,
          resource: "*",
          effect: "allow" as const,
        })),
      ]
    case "edit-markdown":
      return [
        { action: "edit", resource: "*", effect: "deny" as const },
        { action: "edit", resource: "*.md", effect: "allow" as const },
        ...restriction.denyActions.map((action) => ({
          action,
          resource: "*",
          effect: "deny" as const,
        })),
      ]
  }
}

class AgentRegistrationError extends OmoError {
  constructor(readonly agentID: string) {
    super(
      "agent-collision",
      `Agent ${agentID} already exists; rename it or disable its other registration before enabling omo.`,
    )
  }
}

export async function registerAgents(
  ctx: Plugin.Context,
  options: ResolvedOptions,
): Promise<() => Promise<void>> {
  const configured = new Map(options.profiles.map((profile) => [profile.id, profile]))
  // Consultation systems are resolved by profile ID, never by array position:
  // reordering task profiles must not swap writer/reader prompts.
  const consultationSystem = (write: boolean) => {
    const id = write ? "executor" : "explore"
    const found = profiles.find((profile) => profile.id === id)
    if (!found) throw new AgentRegistrationError(id)
    return found.system
  }
  const definitions = [
    ...profiles,
    ...options.profiles
      .filter((profile) => !profiles.some((builtin) => builtin.id === profile.id))
      .map((profile) => ({
        id: profile.id,
        description: "Configured omo task profile",
        write: profile.allowWrite,
        mode: profile.mode,
        system: consultationSystem(profile.allowWrite),
        restriction: undefined as AgentRestriction | undefined,
      })),
  ]
  const agents = await ctx.agent.transform((editor) => {
    // Check the complete batch first: no partial mutation or silent takeover.
    for (const profile of definitions) {
      const existing = editor.get(profile.id)
      const standardExplore =
        profile.id === "explore" &&
        existing?.mode === "subagent" &&
        existing.description === hostExploreDescription &&
        !existing.hidden
      if (existing && !standardExplore) throw new AgentRegistrationError(profile.id)
    }
    for (const profile of definitions) {
      editor.update(profile.id, (agent) => {
        agent.description = profile.description
        agent.mode = configured.get(profile.id)?.mode ?? profile.mode
        agent.system = profile.system
        const config = configured.get(profile.id)
        if (config?.model) {
          const { providerID, modelID, variant } = config.model
          agent.model = Model.Ref.parse(`${providerID}/${modelID}${variant ? `#${variant}` : ""}`)
        }
        if (profile.restriction) {
          agent.permissions.push(...restrictionRules(profile.restriction))
        } else if (!profile.write || config?.allowWrite === false) {
          agent.permissions.push(
            { action: "edit", resource: "*", effect: "deny" },
            { action: "shell", resource: "*", effect: "deny" },
          )
        }
        // An explicit read-only override wins over any capability grant.
        if (config?.allowWrite === false && profile.restriction) {
          agent.permissions.push(
            { action: "edit", resource: "*", effect: "deny" },
            { action: "shell", resource: "*", effect: "deny" },
          )
        }
      })
    }
  })
  const restrictions = new Map(
    definitions
      .filter((profile) => profile.restriction !== undefined)
      .map((profile) => [profile.id, profile.restriction as AgentRestriction]),
  )
  const readonlyIDs = new Set(
    definitions
      .filter(
        (profile) =>
          (profile.restriction === undefined && !profile.write) ||
          configured.get(profile.id)?.allowWrite === false,
      )
      .map((profile) => profile.id),
  )
  const guard = await ctx.permission
    .hook("evaluate", (input) => {
      if (!input.agent || !input.action) return
      // "task" is the V1 alias for the canonical V2 subagent action.
      const action = input.action === "task" ? "subagent" : input.action
      const deny = (message: string) => {
        input.effect = "deny"
        input.message = message
      }
      const restriction = restrictions.get(input.agent)
      if (restriction) {
        switch (restriction.kind) {
          case "deny-actions":
            if (restriction.actions.includes(action)) {
              deny(
                action === "subagent"
                  ? "omo consultation profiles do not delegate. Return the finding to the caller for routing."
                  : CONSULT_DENY_MESSAGE,
              )
            }
            return
          case "allow-only":
            if (!restriction.actions.includes(action)) {
              deny(`omo profile ${input.agent} permits only: ${restriction.actions.join(", ")}.`)
            }
            return
          case "edit-markdown":
            if (
              action === "edit" &&
              Array.isArray(input.resources) &&
              !input.resources.every((resource) => resource.endsWith(".md"))
            ) {
              deny(
                "omo planning profiles may only write .md files; shell and code edits are denied.",
              )
              return
            }
            if (restriction.denyActions.includes(action)) deny(CONSULT_DENY_MESSAGE)
            return
        }
      }
      if (readonlyIDs.has(input.agent) && (action === "shell" || action === "edit")) {
        deny(CONSULT_DENY_MESSAGE)
      }
    })
    .catch(async (error) => {
      await agents.dispose()
      throw error
    })
  const ownedIDs = new Set(definitions.map((profile) => profile.id))
  const modelGuard = await ctx.session
    .hook("model.request", (input) => {
      if (ownedIDs.has(input.agent))
        assertAgentModelAllowed(options, input.agent, {
          providerID: input.model.providerID,
          modelID: input.model.id,
          variant: input.model.variant,
        })
    })
    .catch(async (error) => {
      try {
        await guard.dispose()
      } finally {
        await agents.dispose()
      }
      throw error
    })
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    try {
      await modelGuard.dispose()
    } finally {
      try {
        await guard.dispose()
      } finally {
        await agents.dispose()
      }
    }
  }
}
