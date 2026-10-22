import { describe, expect, test } from "bun:test"
import { createPlan } from "../../src/plans/model"
import { verifyStep } from "../../src/plans/verification"

const input = {
  id: "plan",
  projectID: "project",
  parentSessionID: "parent",
  at: 100,
  steps: [{ id: "build", objective: "Build", dependencies: [] }],
}

function verifyingStep() {
  const pending = createPlan(input).steps[0]
  if (!pending) throw new Error("Build step is missing")
  return {
    ...pending,
    state: "verifying" as const,
    attempts: [
      {
        attemptID: "attempt-1",
        sessionID: "child",
        parentSessionID: "parent",
        agentID: "executor",
        startedAt: 101,
        state: "verifying" as const,
      },
    ],
  }
}

const bound = {
  id: "check",
  description: "bun run check: exit 0",
  command: "bun run check",
  exitCode: 0,
  revision: "abc123def456",
  origin: "auto" as const,
  attemptID: "attempt-1",
}

describe("evidence result binding (P1-1)", () => {
  test("rejects evidence without command and exit code", () => {
    const step = verifyingStep()
    const result = verifyStep(
      step,
      [{ id: "check", description: "Tests passed" }] as unknown as Parameters<typeof verifyStep>[1],
      undefined,
      {} as unknown as Parameters<typeof verifyStep>[3],
    )
    expect(result.ok).toBe(false)
  })
  test("rejects artifact without hash", () => {
    const step = verifyingStep()
    const result = verifyStep(
      step,
      [{ ...bound, artifact: "report.txt" }] as unknown as Parameters<typeof verifyStep>[1],
      undefined,
      {} as unknown as Parameters<typeof verifyStep>[3],
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("hash")
  })
  test("rejects evidence without revision and origin", () => {
    const step = verifyingStep()
    const { revision: _revision, origin: _origin, ...stripped } = bound
    const result = verifyStep(
      step,
      [stripped] as unknown as Parameters<typeof verifyStep>[1],
      undefined,
      {} as unknown as Parameters<typeof verifyStep>[3],
    )
    expect(result.ok).toBe(false)
  })
  test("rejects human evidence without reviewer", () => {
    const step = verifyingStep()
    const result = verifyStep(
      step,
      [{ ...bound, origin: "human" }] as unknown as Parameters<typeof verifyStep>[1],
      undefined,
      {} as unknown as Parameters<typeof verifyStep>[3],
    )
    expect(result.ok).toBe(false)
    expect(result.reason?.toLowerCase()).toContain("reviewer")
  })
  test("rejects reused evidence bound to another attempt or already seen", () => {
    const step = verifyingStep()
    const foreign = verifyStep(
      step,
      [{ ...bound, attemptID: "attempt-2" }] as unknown as Parameters<typeof verifyStep>[1],
      undefined,
      { attemptID: "attempt-1" } as unknown as Parameters<typeof verifyStep>[3],
    )
    expect(foreign.ok).toBe(false)
    const duplicate = verifyStep(
      step,
      [bound] as unknown as Parameters<typeof verifyStep>[1],
      undefined,
      { attemptID: "attempt-1", seenEvidenceIDs: ["check"] } as unknown as Parameters<
        typeof verifyStep
      >[3],
    )
    expect(duplicate.ok).toBe(false)
  })
})
