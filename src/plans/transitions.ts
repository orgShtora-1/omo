import type { Plan, PlanEvent, PlanStep } from "../contracts"
import { PlanError } from "./model"
import { evidenceContentError } from "./verification"

export function transition(plan: Plan, event: PlanEvent): Plan {
  if (plan.appliedEvents.includes(event.id)) return plan
  if (plan.cancelledAt !== undefined) throw new PlanError("parent-cancelled", plan.id)
  function commit(steps: readonly PlanStep[]): Plan {
    return {
      ...plan,
      revision: plan.revision + 1,
      updatedAt: event.at,
      appliedEvents: [...plan.appliedEvents, event.id],
      steps,
    }
  }
  function finish(step: PlanStep, state: "blocked" | "failed" | "cancelled"): PlanStep {
    return {
      ...step,
      state,
      attempts: step.attempts.map((attempt, index) =>
        index === step.attempts.length - 1 &&
        (step.state === "running" || step.state === "verifying")
          ? { ...attempt, state, finishedAt: attempt.finishedAt ?? event.at }
          : attempt,
      ),
    }
  }
  if (event.type === "cancel-parent") {
    return {
      ...commit(
        plan.steps.map((step) =>
          step.state === "completed" || step.state === "cancelled"
            ? step
            : finish(step, "cancelled"),
        ),
      ),
      cancelledAt: event.at,
    }
  }
  const step = plan.steps.find((step) => step.id === event.stepID)
  if (!step) throw new PlanError("unknown-step", event.stepID)
  let next: PlanStep
  if (event.type === "claim" && step.state === "pending") {
    if (
      step.dependencies.some(
        (id) => plan.steps.find((item) => item.id === id)?.state !== "completed",
      )
    ) {
      throw new PlanError("dependencies-incomplete", step.id)
    }
    if (event.attempt.parentSessionID !== plan.parentSessionID)
      throw new PlanError("foreign-parent", step.id)
    if (
      plan.steps.some((item) =>
        item.attempts.some((attempt) => attempt.attemptID === event.attempt.attemptID),
      )
    ) {
      throw new PlanError("duplicate-attempt", event.attempt.attemptID)
    }
    next = {
      ...step,
      state: "running",
      attempts: [
        ...step.attempts,
        {
          ...structuredClone(event.attempt),
          startedAt: event.at,
          state: "running",
        },
      ],
    }
  } else if (event.type === "execution-finished" && step.state === "running") {
    const current = step.attempts.at(-1)
    if (current?.attemptID !== event.attemptID)
      throw new PlanError("stale-attempt", event.attemptID)
    next = {
      ...step,
      state: "verifying",
      attempts: step.attempts.map((attempt) =>
        attempt === current ? { ...attempt, state: "verifying", finishedAt: event.at } : attempt,
      ),
    }
  } else if (event.type === "complete" && step.state === "verifying") {
    if (event.evidence.some((item) => !item.id.trim() || !item.description.trim())) {
      throw new PlanError("invalid-evidence", step.id)
    }
    if (!event.evidence.length && !event.waiver?.trim())
      throw new PlanError("verification-required", step.id)
    if (event.evidence.length) {
      const attemptID = step.attempts.at(-1)?.attemptID
      const seenEvidenceIDs = plan.steps
        .filter((item) => item.id !== step.id)
        .flatMap((item) => item.evidence.map((entry) => entry.id))
      const error = evidenceContentError(event.evidence, { attemptID, seenEvidenceIDs })
      if (error) {
        const code = /already used|duplicated|bound to attempt/.test(error)
          ? "duplicate-evidence"
          : "invalid-evidence"
        throw new PlanError(code, `${step.id}: ${error}`)
      }
    }
    const completedAttemptID = step.attempts.at(-1)?.attemptID
    next = {
      ...step,
      state: "completed",
      evidence: structuredClone(event.evidence).map((item) =>
        item.attemptID === undefined && completedAttemptID !== undefined
          ? { ...item, attemptID: completedAttemptID }
          : item,
      ),
      ...(event.waiver?.trim() ? { waiver: event.waiver.trim() } : {}),
      attempts: step.attempts.map((attempt, index) =>
        index === step.attempts.length - 1 ? { ...attempt, state: "completed" } : attempt,
      ),
    }
  } else if (
    (event.type === "block" || event.type === "fail") &&
    (step.state === "pending" || step.state === "running" || step.state === "verifying")
  ) {
    if (!event.reason.trim()) throw new PlanError("reason-required", step.id)
    next = {
      ...finish(step, event.type === "block" ? "blocked" : "failed"),
      reason: event.reason.trim(),
    }
  } else if (event.type === "resume" && (step.state === "blocked" || step.state === "failed")) {
    const { reason: _, ...rest } = step
    next = { ...rest, state: "pending" }
  } else if (event.type === "cancel" && step.state !== "completed" && step.state !== "cancelled") {
    next = finish(step, "cancelled")
  } else throw new PlanError("illegal-transition", `${step.state} via ${event.type}`)
  return commit(plan.steps.map((item) => (item.id === step.id ? next : item)))
}
