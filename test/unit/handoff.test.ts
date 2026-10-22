import { expect, test } from "bun:test"
import { buildHandoff } from "../../src/delegation/handoff.js"

const input = {
  taskID: "task-1",
  objective: "Fix the scoped defect",
  constraints: ["Only edit src/payment.ts", "Do not publish"],
  evidence: ["test report: reports/payment.json"],
  artifacts: ["src/payment.ts:12"],
  scope: "Payment validation only",
  exitCriteria: ["Existing payment tests pass"],
  context: "Optional background ".repeat(100),
}

test("bounded handoff preserves objective restrictions evidence and artifact references", () => {
  const text = buildHandoff({ ...input, maxChars: 700 })
  expect(text.length).toBeLessThanOrEqual(700)
  for (const value of [
    input.taskID,
    input.objective,
    input.scope,
    ...input.exitCriteria,
    ...input.constraints,
    ...input.evidence,
    ...input.artifacts,
  ]) {
    expect(text).toContain(value)
  }
  expect(text).toContain("[context truncated]")
  expect(text).toContain("Pending")
})

test("oversized mandatory handoff fails visibly instead of dropping instructions", () => {
  expect(() => buildHandoff({ ...input, maxChars: 50 })).toThrow("mandatory handoff exceeds")
})
