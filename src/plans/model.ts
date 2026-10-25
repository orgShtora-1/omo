import type { Plan, PlanInput } from "../contracts"
import { OmoError } from "../errors/base.js"

export type PlanErrorCode =
  | "duplicate-step"
  | "dependency-cycle"
  | "missing-dependency"
  | "illegal-transition"
  | "unknown-step"
  | "dependencies-incomplete"
  | "foreign-parent"
  | "duplicate-attempt"
  | "stale-attempt"
  | "invalid-evidence"
  | "duplicate-evidence"
  | "verification-required"
  | "reason-required"
  | "parent-cancelled"

export class PlanError extends OmoError {
  constructor(code: PlanErrorCode, detail: string) {
    super(code, `${code}: ${detail}`)
  }
}

export function createPlan(input: PlanInput): Plan {
  const steps = new Map(input.steps.map((step) => [step.id, step]))
  if (steps.size !== input.steps.length)
    throw new PlanError("duplicate-step", "step IDs must be unique")
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(id: string): void {
    if (visiting.has(id)) throw new PlanError("dependency-cycle", id)
    if (visited.has(id)) return
    const step = steps.get(id)
    if (!step) throw new PlanError("missing-dependency", id)
    visiting.add(id)
    for (const dependency of step.dependencies) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of input.steps) visit(step.id)
  return {
    schemaVersion: 1,
    id: input.id,
    projectID: input.projectID,
    parentSessionID: input.parentSessionID,
    revision: 0,
    createdAt: input.at,
    updatedAt: input.at,
    appliedEvents: [],
    steps: input.steps.map((step) => ({
      ...step,
      dependencies: [...step.dependencies],
      state: "pending",
      attempts: [],
      evidence: [],
    })),
  }
}
