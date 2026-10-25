import type { Plan } from "../contracts"
import { OmoError } from "../errors/base.js"
import { createPlan } from "../plans/model"

export type StateErrorCode =
  | "revision-conflict"
  | "scope-mismatch"
  | "corrupt-state"
  | "future-version"
  | "unsupported-version"
export class StateError extends OmoError {
  constructor(code: StateErrorCode, detail: string) {
    super(code, `${code}: ${detail}`)
  }
}

const states = new Set([
  "pending",
  "running",
  "verifying",
  "completed",
  "blocked",
  "failed",
  "cancelled",
])
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0
const time = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const sha256Hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value)
const exitCode = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value)
const origin = (value: unknown): value is string => value === "auto" || value === "human"
const unique = (values: string[]) => new Set(values).size === values.length

// First published schema is 1. Unknown versions must never be rewritten as current.
// Compatible additive fields are retained, including the original event history.
export function readPlan(payload: string): Plan {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw new StateError("corrupt-state", "invalid JSON; original row retained")
  }
  if (!record(value)) throw new StateError("corrupt-state", "plan must be an object")
  if (typeof value.schemaVersion === "number" && value.schemaVersion > 1) {
    throw new StateError(
      "future-version",
      `schema ${value.schemaVersion}; upgrade omo before loading`,
    )
  }
  if (value.schemaVersion !== 1)
    throw new StateError("unsupported-version", "expected schemaVersion 1")
  const fail = (detail: string): never => {
    throw new StateError("corrupt-state", `${detail}; original row retained`)
  }
  function check(condition: unknown, detail: string): asserts condition {
    if (!condition) fail(detail)
  }
  const id = value.id
  const projectID = value.projectID
  const parentSessionID = value.parentSessionID
  const revision = value.revision
  const createdAt = value.createdAt
  const updatedAt = value.updatedAt
  const cancelledAt = value.cancelledAt
  const appliedEvents = value.appliedEvents
  const steps: unknown[] = Array.isArray(value.steps) ? value.steps : fail("invalid plan envelope")
  check(text(id), "invalid plan envelope")
  check(text(projectID), "invalid plan envelope")
  check(text(parentSessionID), "invalid plan envelope")
  check(time(revision), "invalid plan envelope")
  check(time(createdAt), "invalid plan envelope")
  check(time(updatedAt), "invalid plan envelope")
  check(updatedAt >= createdAt, "invalid plan envelope")
  check(cancelledAt === undefined || time(cancelledAt), "invalid plan envelope")
  check(strings(appliedEvents), "invalid plan envelope")
  check(unique(appliedEvents), "invalid plan envelope")
  check(steps.length > 0, "invalid plan envelope")
  const seen = new Set<string>()
  for (const entry of steps) {
    check(record(entry), "invalid step")
    const stepID = entry.id
    const objective = entry.objective
    const dependencies = entry.dependencies
    const state = entry.state
    const stepAttempts: unknown[] = Array.isArray(entry.attempts)
      ? entry.attempts
      : fail("invalid step")
    const stepEvidence: unknown[] = Array.isArray(entry.evidence)
      ? entry.evidence
      : fail("invalid step")
    const waiver = entry.waiver
    const reason = entry.reason
    check(text(stepID), "invalid step")
    check(text(objective), "invalid step")
    check(strings(dependencies), "invalid step")
    check(unique(dependencies), "invalid step")
    check(text(state), "invalid step")
    check(states.has(state), "invalid step")
    check(waiver === undefined || text(waiver), "invalid step")
    check(reason === undefined || text(reason), "invalid step")
    for (const item of stepEvidence) {
      check(record(item), "invalid evidence")
      check(text(item.id), "invalid evidence")
      check(text(item.description), "invalid evidence")
      check(item.artifact === undefined || text(item.artifact), "invalid evidence")
      check(item.command === undefined || text(item.command), "invalid evidence")
      check(item.exitCode === undefined || exitCode(item.exitCode), "invalid evidence")
      check(item.revision === undefined || text(item.revision), "invalid evidence")
      check(item.artifactHash === undefined || sha256Hex(item.artifactHash), "invalid evidence")
      check(item.origin === undefined || origin(item.origin), "invalid evidence")
      check(item.attemptID === undefined || text(item.attemptID), "invalid evidence")
      check(item.reviewer === undefined || text(item.reviewer), "invalid evidence")
    }
    check(
      state !== "completed" || stepEvidence.length > 0 || text(waiver),
      "completion without verification",
    )
    for (const entryAttempt of stepAttempts) {
      check(record(entryAttempt), "invalid attempt")
      const attemptID = entryAttempt.attemptID
      const sessionID = entryAttempt.sessionID
      const agentID = entryAttempt.agentID
      const attemptParent = entryAttempt.parentSessionID
      const attemptState = entryAttempt.state
      const startedAt = entryAttempt.startedAt
      const finishedAt = entryAttempt.finishedAt
      const model = entryAttempt.model
      check(text(attemptID), "invalid attempt")
      check(text(sessionID), "invalid attempt")
      check(text(agentID), "invalid attempt")
      check(attemptParent === parentSessionID, "invalid attempt")
      check(!seen.has(attemptID), "invalid attempt")
      check(text(attemptState), "invalid attempt")
      check(states.has(attemptState), "invalid attempt")
      check(time(startedAt), "invalid attempt")
      if (finishedAt !== undefined) {
        check(time(finishedAt), "invalid attempt")
        check(finishedAt >= startedAt, "invalid attempt")
      }
      if (model !== undefined) {
        check(record(model), "invalid model")
        check(text(model.providerID), "invalid model")
        check(text(model.modelID), "invalid model")
        check(model.variant === undefined || text(model.variant), "invalid model")
      }
      seen.add(attemptID)
    }
    if (state === "running" || state === "verifying") {
      const last = stepAttempts.at(-1)
      check(record(last) && last.state === state, "active step without matching attempt")
    }
    if (cancelledAt !== undefined && state !== "completed" && state !== "cancelled")
      fail("cancelled parent has active work")
  }
  try {
    createPlan({ ...value, at: createdAt } as Parameters<typeof createPlan>[0])
  } catch {
    fail("invalid dependency graph")
  }
  return value as Plan
}
