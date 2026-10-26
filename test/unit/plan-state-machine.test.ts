import { describe, expect, it } from "bun:test"
import type { PlanEvent } from "../../src/contracts"
import { createPlan } from "../../src/plans/model"
import { transition } from "../../src/plans/transitions"

const baseInput = {
  id: "plan-1",
  projectID: "proj",
  parentSessionID: "sess",
  at: 1000,
  steps: [
    { id: "a", objective: "step a", dependencies: [] },
    { id: "b", objective: "step b", dependencies: ["a"] },
    { id: "c", objective: "step c", dependencies: ["a"] },
    { id: "d", objective: "step d", dependencies: ["b", "c"] },
  ],
}

function claim(stepID: string, attemptID = "att-1"): PlanEvent {
  return {
    id: `claim-${attemptID}`,
    at: 1001,
    type: "claim",
    stepID,
    attempt: {
      attemptID,
      sessionID: "child-1",
      parentSessionID: "sess",
      agentID: "executor",
    },
  }
}

describe("plan state machine — valid transitions", () => {
  it("claims a pending step when dependencies are complete", () => {
    const plan = createPlan(baseInput)
    const claimed = transition(plan, claim("a"))
    expect(claimed.steps[0]?.state).toBe("running")
    expect(claimed.steps[0]?.attempts).toHaveLength(1)
  })

  it("transitions running → verifying → completed", () => {
    const plan = createPlan(baseInput)
    const claimed = transition(plan, claim("a"))
    const verifying = transition(claimed, {
      id: "finish-a",
      at: 1002,
      type: "execution-finished",
      stepID: "a",
      attemptID: "att-1",
    })
    expect(verifying.steps[0]?.state).toBe("verifying")
    const completed = transition(verifying, {
      id: "complete-a",
      at: 1003,
      type: "complete",
      stepID: "a",
      evidence: [
        {
          id: "e1",
          description: "build ok",
          command: "bun test",
          exitCode: 0,
          revision: "abc123",
          origin: "auto" as const,
        },
      ],
    })
    expect(completed.steps[0]?.state).toBe("completed")
  })

  it("cancels all pending/running steps when parent is cancelled", () => {
    const plan = createPlan(baseInput)
    const claimed = transition(plan, claim("a"))
    const cancelled = transition(claimed, { id: "cancel-parent", at: 1002, type: "cancel-parent" })
    expect(cancelled.cancelledAt).toBe(1002)
    for (const step of cancelled.steps) {
      if (step.id !== "a") expect(step.state).toBe("cancelled")
    }
  })
})

describe("plan state machine — error transitions", () => {
  it("rejects claiming a step with incomplete dependencies", () => {
    const plan = createPlan(baseInput)
    expect(() => transition(plan, claim("b"))).toThrow("dependencies-incomplete")
  })

  it("rejects a foreign parent session", () => {
    const plan = createPlan(baseInput)
    const event: PlanEvent = {
      id: "foreign-claim",
      at: 1001,
      type: "claim",
      stepID: "a",
      attempt: {
        attemptID: "att-1",
        sessionID: "child-1",
        parentSessionID: "wrong-parent",
        agentID: "executor",
      },
    }
    expect(() => transition(plan, event)).toThrow("foreign-parent")
  })

  it("rejects duplicate attempt IDs across steps", () => {
    const plan = createPlan({
      ...baseInput,
      id: "dup-test",
      steps: [
        { id: "a", objective: "step a", dependencies: [] },
        { id: "b", objective: "step b", dependencies: [] },
      ],
    })
    const claimedA = transition(plan, claim("a", "att-1"))
    // Step b is independent, so it's still pending — but att-1 is already used on step a
    const duplicateEvent: PlanEvent = {
      id: "claim-b-dup",
      at: 1002,
      type: "claim",
      stepID: "b",
      attempt: {
        attemptID: "att-1",
        sessionID: "child-1",
        parentSessionID: "sess",
        agentID: "executor",
      },
    }
    expect(() => transition(claimedA, duplicateEvent)).toThrow("duplicate-attempt")
  })

  it("throws PlanError for unknown step IDs", () => {
    const plan = createPlan(baseInput)
    const event: PlanEvent = {
      id: "bad-claim",
      at: 1001,
      type: "claim",
      stepID: "nonexistent",
      attempt: {
        attemptID: "att-1",
        sessionID: "child-1",
        parentSessionID: "sess",
        agentID: "executor",
      },
    }
    expect(() => transition(plan, event)).toThrow("unknown-step")
  })

  it("throws on dependency cycle in plan creation", () => {
    expect(() =>
      createPlan({
        ...baseInput,
        id: "cycle",
        steps: [
          { id: "x", objective: "x", dependencies: ["y"] },
          { id: "y", objective: "y", dependencies: ["x"] },
        ],
      }),
    ).toThrow("dependency-cycle")
  })

  it("throws on missing dependency in plan creation", () => {
    expect(() =>
      createPlan({
        ...baseInput,
        id: "missing",
        steps: [{ id: "x", objective: "x", dependencies: ["z"] }],
      }),
    ).toThrow("missing-dependency")
  })

  it("throws on duplicate step IDs", () => {
    expect(() =>
      createPlan({
        ...baseInput,
        id: "dup",
        steps: [
          { id: "x", objective: "x", dependencies: [] },
          { id: "x", objective: "x2", dependencies: [] },
        ],
      }),
    ).toThrow("duplicate-step")
  })

  it("blocks claims after parent cancellation", () => {
    const plan = createPlan(baseInput)
    const cancelled = transition(plan, { id: "cancel-parent", at: 1001, type: "cancel-parent" })
    expect(() => transition(cancelled, claim("a"))).toThrow("parent-cancelled")
  })
})

describe("plan state machine — evidence & verification", () => {
  it("requires evidence when no waiver provided on complete", () => {
    const plan = createPlan(baseInput)
    const claimed = transition(plan, claim("a"))
    const verifying = transition(claimed, {
      id: "finish-a",
      at: 1002,
      type: "execution-finished",
      stepID: "a",
      attemptID: "att-1",
    })
    expect(() =>
      transition(verifying, {
        id: "complete-a",
        at: 1003,
        type: "complete",
        stepID: "a",
        evidence: [],
      }),
    ).toThrow("verification-required")
  })

  it("accepts waiver as alternative to evidence", () => {
    const plan = createPlan(baseInput)
    const claimed = transition(plan, claim("a"))
    const verifying = transition(claimed, {
      id: "finish-a",
      at: 1002,
      type: "execution-finished",
      stepID: "a",
      attemptID: "att-1",
    })
    const completed = transition(verifying, {
      id: "waived-a",
      at: 1003,
      type: "complete",
      stepID: "a",
      evidence: [],
      waiver: "Documentation-only waiver",
    })
    expect(completed.steps[0]?.state).toBe("completed")
  })
})

describe("plan revision tracking", () => {
  it("increments revision on every transition", () => {
    const plan = createPlan(baseInput)
    expect(plan.revision).toBe(0)
    const t1 = transition(plan, claim("a"))
    expect(t1.revision).toBe(1)
    const t2 = transition(t1, { id: "cancel-parent", at: 1002, type: "cancel-parent" })
    expect(t2.revision).toBe(2)
  })

  it("never decrements revision", () => {
    const plan = createPlan(baseInput)
    let prev = plan.revision
    for (let i = 0; i < 10; i++) {
      const next = transition(plan, claim("a"))
      expect(next.revision).toBeGreaterThanOrEqual(prev)
      prev = next.revision
    }
  })
})
