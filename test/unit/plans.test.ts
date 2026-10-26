import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPlan } from "../../src/plans/model"
import { transition } from "../../src/plans/transitions"
import { verifyStep } from "../../src/plans/verification"

function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index]
  if (item === undefined) throw new Error(`test invariant: ${what}[${index}] is missing`)
  return item
}

const input = {
  id: "plan",
  projectID: "project",
  parentSessionID: "parent",
  at: 100,
  steps: [
    { id: "build", objective: "Build", dependencies: [] },
    { id: "review", objective: "Review", dependencies: ["build"] },
  ],
}
const claim = {
  id: "claim-1",
  at: 101,
  type: "claim" as const,
  stepID: "build",
  attempt: {
    attemptID: "attempt-1",
    sessionID: "child",
    parentSessionID: "parent",
    agentID: "executor",
  },
}

describe("artifact verification", () => {
  test("artifact verification preserves state, evidence, and waiver requirements", () => {
    const pending = createPlan(input).steps[0]
    if (!pending) throw new Error("Build step is missing")
    const step = { ...pending, state: "verifying" as const }
    const options = { verifyArtifacts: true }
    expect(verifyStep(pending, [], "Justified waiver", options).ok).toBe(false)
    expect(verifyStep(step, [], " ", options).ok).toBe(false)
    expect(verifyStep(step, [], "Documentation-only waiver", options)).toEqual({ ok: true })
    expect(verifyStep(step, [{ id: " ", description: "Report" }], undefined, options).ok).toBe(
      false,
    )
    expect(
      verifyStep(step, [{ id: "report", description: "Report", artifact: " " }], "Waiver", options)
        .ok,
    ).toBe(false)
  })
  test("project confinement rejects traversal, absolute and symlink escapes", () => {
    const base = mkdtempSync(join(tmpdir(), "omo-verification-"))
    const root = join(base, "project")
    const outside = join(base, "project-other")
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, "report.txt"), "outside")
    symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir")
    try {
      const step = { ...at(createPlan(input).steps, 0, "plan step"), state: "verifying" as const }
      for (const artifact of [
        "../project-other/report.txt",
        join(outside, "report.txt"),
        "link/report.txt",
      ]) {
        const result = verifyStep(
          step,
          [
            {
              id: "report",
              description: "Report",
              artifact,
              command: "bun run check",
              exitCode: 0,
              revision: "abc123",
              artifactHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              origin: "auto",
            },
          ],
          undefined,
          { verifyArtifacts: true, projectRoot: root },
        )
        expect(result.ok).toBe(false)
        expect(result.reason).toContain("outside project root")
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
  test("artifact checks are opt-in, synchronous, and reject missing artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "omo-verification-"))
    try {
      const step = { ...at(createPlan(input).steps, 0, "plan step"), state: "verifying" as const }
      const evidence = [
        {
          id: "report",
          description: "Test report",
          artifact: "report.txt",
          command: "bun run check",
          exitCode: 0,
          revision: "abc123",
          artifactHash: "284d1e8c4918248233df17642bbb940c001e1fa856c18aab86ba6dbe7813eb13",
          origin: "auto" as const,
        },
      ]
      expect(verifyStep(step, evidence)).toEqual({ ok: true })
      expect(
        verifyStep(step, evidence, undefined, { verifyArtifacts: false, projectRoot: root }),
      ).toEqual({ ok: true })
      expect(
        verifyStep(step, evidence, undefined, { verifyArtifacts: true, projectRoot: root }).ok,
      ).toBe(false)
      writeFileSync(join(root, "report.txt"), "passed")
      expect(
        verifyStep(step, evidence, undefined, { verifyArtifacts: true, projectRoot: root }),
      ).toEqual({ ok: true })
      expect(
        verifyStep(
          step,
          [
            {
              id: "test",
              description: "Observed command",
              command: "bun test test/unit",
              exitCode: 0,
              revision: "abc123",
              origin: "auto" as const,
            },
          ],
          undefined,
          {
            verifyArtifacts: true,
            projectRoot: root,
          },
        ),
      ).toEqual({ ok: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("plan graph", () => {
  test("preserves independent IDs and validates the dependency graph before execution", () => {
    const plan = createPlan({
      id: "plan-1",
      projectID: "project",
      parentSessionID: "parent",
      at: 100,
      steps: [
        { id: "review", objective: "Review output", dependencies: ["build"] },
        { id: "build", objective: "Build output", dependencies: [] },
      ],
    })
    expect(plan.schemaVersion).toBe(1)
    expect(plan.steps.map((step) => [step.id, step.state])).toEqual([
      ["review", "pending"],
      ["build", "pending"],
    ])
    expect(plan.parentSessionID).toBe("parent")
    expect(plan.revision).toBe(0)
    expect(plan.createdAt).toBe(100)
    expect(() =>
      createPlan({
        ...plan,
        at: 100,
        steps: [{ id: "review", objective: "Review", dependencies: ["missing"] }],
      }),
    ).toThrow(/missing-dependency/)
    expect(() =>
      createPlan({
        ...plan,
        at: 100,
        steps: [
          { id: "a", objective: "A", dependencies: ["b"] },
          { id: "b", objective: "B", dependencies: ["a"] },
        ],
      }),
    ).toThrow(/dependency-cycle/)
    expect(() =>
      createPlan({
        ...plan,
        at: 100,
        steps: [
          { id: "a", objective: "A", dependencies: [] },
          { id: "a", objective: "Duplicate", dependencies: [] },
        ],
      }),
    ).toThrow(/duplicate-step/)
  })
})

describe("plan transitions", () => {
  test("blocked and failed steps require an explicit resume, and attempts cannot be reused", () => {
    const running = transition(createPlan(input), claim)
    expect(() =>
      transition(running, {
        id: "bad-block",
        at: 102,
        type: "block",
        stepID: "build",
        reason: " ",
      }),
    ).toThrow(/reason-required/)
    const blocked = transition(running, {
      id: "blocked",
      at: 102,
      type: "block",
      stepID: "build",
      reason: "Missing host authorization API",
    })
    expect(at(blocked.steps, 0, "build step").state).toBe("blocked")
    expect(at(blocked.steps, 0, "build step").reason).toContain("authorization")
    expect(() => transition(blocked, { ...claim, id: "auto" })).toThrow(/illegal-transition/)
    const ready = transition(blocked, { id: "resume", at: 103, type: "resume", stepID: "build" })
    expect(at(ready.steps, 0, "build step").state).toBe("pending")
    expect(at(ready.steps, 0, "build step").reason).toBeUndefined()
    expect(() => transition(ready, { ...claim, id: "reuse" })).toThrow(/duplicate-attempt/)
    const retry = transition(ready, {
      ...claim,
      id: "retry",
      at: 104,
      attempt: { ...claim.attempt, attemptID: "attempt-2" },
    })
    const failed = transition(retry, {
      id: "fail",
      at: 105,
      type: "fail",
      stepID: "build",
      reason: "Host execution failed",
    })
    expect(at(failed.steps, 0, "build step").attempts.map((attempt) => attempt.state)).toEqual([
      "blocked",
      "failed",
    ])
    expect(at(at(failed.steps, 0, "build step").attempts, 1, "build attempt").finishedAt).toBe(105)
    expect(
      at(
        transition(failed, { id: "retry-ready", at: 106, type: "resume", stepID: "build" }).steps,
        0,
        "build step",
      ).state,
    ).toBe("pending")
  })
  test("parent cancellation during verification never reopens work or accepts late completion", () => {
    const running = transition(createPlan(input), claim)
    const verifying = transition(running, {
      id: "finish",
      at: 102,
      type: "execution-finished",
      stepID: "build",
      attemptID: "attempt-1",
    })
    const cancelled = transition(verifying, { id: "cancel-parent", at: 103, type: "cancel-parent" })
    expect(cancelled.cancelledAt).toBe(103)
    expect(cancelled.steps.map((step) => step.state)).toEqual(["cancelled", "cancelled"])
    expect(at(verifying.steps, 0, "build step").state).toBe("verifying")
    expect(transition(cancelled, { id: "cancel-parent", at: 103, type: "cancel-parent" })).toBe(
      cancelled,
    )
    expect(() =>
      transition(cancelled, {
        id: "late",
        at: 104,
        type: "complete",
        stepID: "build",
        evidence: [{ id: "test", description: "Passed" }],
      }),
    ).toThrow(/parent-cancelled/)
    expect(() =>
      transition(cancelled, { id: "reopen", at: 104, type: "resume", stepID: "build" }),
    ).toThrow(/parent-cancelled/)
    const childCancelled = transition(running, {
      id: "child-cancel",
      at: 102,
      type: "cancel",
      stepID: "build",
    })
    expect(at(childCancelled.steps, 0, "build step").state).toBe("cancelled")
    expect(at(childCancelled.steps, 1, "review step").state).toBe("pending")
    expect(() =>
      transition(childCancelled, { id: "reopen", at: 103, type: "resume", stepID: "build" }),
    ).toThrow(/illegal-transition/)
  })
  test("execution enters verification and evidence or a justified waiver unlocks dependents", () => {
    const running = transition(createPlan(input), claim)
    expect(() =>
      transition(running, {
        id: "premature",
        at: 102,
        type: "complete",
        stepID: "build",
        evidence: [{ id: "test", description: "Tests passed" }],
      }),
    ).toThrow(/illegal-transition/)
    expect(() =>
      transition(running, {
        id: "foreign",
        at: 102,
        type: "execution-finished",
        stepID: "build",
        attemptID: "old",
      }),
    ).toThrow(/stale-attempt/)
    const verifying = transition(running, {
      id: "finish",
      at: 102,
      type: "execution-finished",
      stepID: "build",
      attemptID: "attempt-1",
    })
    expect(at(verifying.steps, 0, "build step").state).toBe("verifying")
    expect(at(at(verifying.steps, 0, "build step").attempts, 0, "build attempt").finishedAt).toBe(
      102,
    )
    expect(() =>
      transition(verifying, {
        id: "empty",
        at: 103,
        type: "complete",
        stepID: "build",
        evidence: [],
        waiver: "  ",
      }),
    ).toThrow(/verification-required/)
    expect(() =>
      transition(verifying, {
        id: "blank",
        at: 103,
        type: "complete",
        stepID: "build",
        evidence: [{ id: "test", description: " " }],
      }),
    ).toThrow(/invalid-evidence/)
    const completed = transition(verifying, {
      id: "verified",
      at: 103,
      type: "complete",
      stepID: "build",
      evidence: [
        {
          id: "test",
          description: "bun test: exit 0",
          artifact: "test-report.txt",
          command: "bun test test/unit",
          exitCode: 0,
          revision: "abc123",
          artifactHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          origin: "auto",
        },
      ],
    })
    expect(at(at(completed.steps, 0, "build step").evidence, 0, "build evidence").artifact).toBe(
      "test-report.txt",
    )
    expect(at(at(completed.steps, 0, "build step").evidence, 0, "build evidence").attemptID).toBe(
      "attempt-1",
    )
    expect(at(completed.steps, 0, "build step").state).toBe("completed")
    expect(() =>
      transition(verifying, {
        id: "foreign-attempt",
        at: 103,
        type: "complete",
        stepID: "build",
        evidence: [
          {
            id: "test",
            description: "bun test: exit 0",
            command: "bun test test/unit",
            exitCode: 0,
            revision: "abc123",
            origin: "auto",
            attemptID: "foreign",
          },
        ],
      }),
    ).toThrow(/duplicate-evidence/)
    expect(
      at(
        transition(completed, {
          ...claim,
          id: "review-claim",
          stepID: "review",
          attempt: { ...claim.attempt, attemptID: "attempt-review" },
        }).steps,
        1,
        "review step",
      ).state,
    ).toBe("running")
    const waived = transition(verifying, {
      id: "waived",
      at: 103,
      type: "complete",
      stepID: "build",
      evidence: [],
      waiver: "Documentation-only step; execution check explicitly waived.",
    })
    expect(at(waived.steps, 0, "build step").waiver).toContain("Documentation-only")
    const reviewing = transition(
      transition(completed, {
        ...claim,
        id: "review-claim",
        stepID: "review",
        attempt: { ...claim.attempt, attemptID: "attempt-review" },
      }),
      {
        id: "review-finished",
        at: 104,
        type: "execution-finished",
        stepID: "review",
        attemptID: "attempt-review",
      },
    )
    expect(() =>
      transition(reviewing, {
        id: "reused",
        at: 105,
        type: "complete",
        stepID: "review",
        evidence: [
          {
            id: "test",
            description: "bun test: exit 0",
            command: "bun test test/unit",
            exitCode: 0,
            revision: "def456",
            origin: "auto",
          },
        ],
      }),
    ).toThrow(/duplicate-evidence/)
  })
  test("claims once, refuses unsatisfied dependencies and preserves the original plan", () => {
    const original = createPlan(input)
    expect(() => transition(original, { ...claim, stepID: "review" })).toThrow(
      /dependencies-incomplete/,
    )
    const running = transition(original, claim)
    expect(at(original.steps, 0, "build step").state).toBe("pending")
    expect(at(running.steps, 0, "build step").state).toBe("running")
    expect(at(running.steps, 0, "build step").attempts).toEqual([
      { ...claim.attempt, startedAt: 101, state: "running" },
    ])
    expect(running.revision).toBe(1)
    expect(transition(running, claim)).toBe(running)
    expect(() => transition(running, { ...claim, id: "claim-2" })).toThrow(/illegal-transition/)
    expect(() =>
      transition(original, { ...claim, attempt: { ...claim.attempt, parentSessionID: "foreign" } }),
    ).toThrow(/foreign-parent/)
  })
})
