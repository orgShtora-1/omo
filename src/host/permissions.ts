import type { DelegationRequest, ResolvedDelegation } from "../contracts"
import type { HostPorts } from "./execution"
import { ExecutionError } from "./execution"

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }
const matches = (pattern: string, value: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  ).test(value)
export function evaluateTaskRules(rules: readonly Rule[], agentID: string): Rule["effect"] {
  let effect: Rule["effect"] = "ask"
  // V2 exposes canonical subagent rules; retain exact V1 task as a migration alias.
  for (const rule of rules)
    if (
      (matches(rule.action, "subagent") || rule.action === "task") &&
      matches(rule.resource, agentID)
    )
      effect = rule.effect
  return effect
}
export async function authorizeParent(
  host: HostPorts,
  request: DelegationRequest,
  resolved: ResolvedDelegation,
): Promise<void> {
  const parent = (await host.session.get({ sessionID: request.parentSessionID })) as Awaited<
    ReturnType<HostPorts["session"]["get"]>
  > & { projectID?: string; permissions?: Rule[] }
  if (parent.projectID !== request.projectID)
    throw new ExecutionError(
      "permission-denied",
      `Parent belongs to another project or project identity is unavailable; action=subagent resource=${resolved.agentID} effect=deny. Remediation: use a parent session whose verified project identity matches ${request.projectID} before retrying`,
    )
  if (!parent.agent)
    throw new ExecutionError(
      "permission-denied",
      `Parent agent is unavailable; cannot establish task authorization; action=subagent resource=${resolved.agentID} effect=deny. Remediation: restore the parent agent identity through the host before retrying`,
    )
  const agent = (await host.agent.get({ agentID: parent.agent })).data
  const effect = evaluateTaskRules(
    [...(agent.permissions ?? []), ...(parent.permissions ?? [])],
    resolved.agentID,
  )
  if (effect !== "allow")
    throw new ExecutionError(
      "permission-denied",
      `Parent subagent rule is ${effect} for ${resolved.agentID}; action=subagent resource=${resolved.agentID} effect=${effect}. Remediation: ${effect === "ask" ? "native task approval is required; obtain approval through the host before retrying" : "this task is denied; ask the project owner to review the denying rule before retrying"}`,
    )
}
