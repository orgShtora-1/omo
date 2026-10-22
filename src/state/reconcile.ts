import type { ExecutionAdapter, Plan, PlanEvent, PlanRepository, Scope } from "../contracts"
import { transition } from "../plans/transitions"

export type RecoveryDecision = {
  kind: "observe" | "complete" | "fail" | "block" | "ready"
  stepID: string
  attemptID?: string
  sessionID?: string
  reason?: string
}

// Decisions only: reconciliation never launches a replacement for an unknown session.
export async function reconcilePlan(
  plan: Plan,
  adapter: ExecutionAdapter,
): Promise<RecoveryDecision[]> {
  const decisions: RecoveryDecision[] = []
  for (const step of plan.steps) {
    if (step.state === "completed") continue
    if (step.state === "pending" && plan.cancelledAt === undefined) {
      if (
        step.dependencies.every(
          (id) => plan.steps.find((other) => other.id === id)?.state === "completed",
        )
      ) {
        decisions.push({ kind: "ready", stepID: step.id })
      }
      continue
    }
    const cancelled = step.state === "cancelled" || plan.cancelledAt !== undefined
    if (!cancelled && step.state !== "running" && step.state !== "verifying") continue
    const attempt = step.attempts.at(-1)
    if (!attempt) continue
    const { state } = await adapter.inspect(attempt.sessionID)
    const identity = { stepID: step.id, attemptID: attempt.attemptID, sessionID: attempt.sessionID }
    if (cancelled) {
      if (state === "running" || state === "unknown")
        decisions.push({
          ...identity,
          kind: "observe",
          reason: "Cancellation is final; native child still requires reconciliation",
        })
    } else if (state === "unknown") {
      decisions.push({
        ...identity,
        kind: "block",
        reason: "Native session is unknown; do not retry admission until reconciled",
      })
    } else if (state === "failed" || state === "cancelled") {
      decisions.push({
        ...identity,
        kind: "fail",
        reason: `Native execution ${state}; resume requires explicit action`,
      })
    } else if (state === "completed" && step.state === "running") {
      decisions.push({ ...identity, kind: "complete" })
    } else {
      decisions.push({ ...identity, kind: "observe" })
    }
  }
  return decisions
}

export async function reconcileAndSave(
  scope: Scope,
  planID: string,
  repository: PlanRepository,
  adapter: ExecutionAdapter,
  at: number,
): Promise<{ plan: Plan; decisions: RecoveryDecision[] }> {
  let plan = await repository.load(scope, planID)
  if (!plan) throw new Error(`unknown-plan: ${planID}`)
  const decisions = await reconcilePlan(plan, adapter)
  for (const decision of decisions) {
    if (decision.kind !== "complete" && decision.kind !== "block" && decision.kind !== "fail")
      continue
    const id = JSON.stringify([
      "omo.recovery",
      planID,
      decision.stepID,
      decision.attemptID,
      decision.kind,
    ])
    const attemptID = decision.attemptID
    const reason = decision.reason
    let event: PlanEvent
    if (decision.kind === "complete") {
      if (!attemptID) throw new Error("recovery-complete requires attemptID")
      event = { id, at, type: "execution-finished", stepID: decision.stepID, attemptID }
    } else {
      if (!reason) throw new Error("recovery decision requires reason")
      event = { id, at, type: decision.kind, stepID: decision.stepID, reason }
    }
    const next = transition(plan, event)
    // A concurrent writer must cause conflict, never an overwrite or a new admission.
    await repository.save(scope, next, plan.revision)
    plan = next
  }
  return { plan, decisions }
}
