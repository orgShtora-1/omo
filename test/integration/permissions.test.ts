import { describe, expect, test } from "bun:test"
import type { DelegationRequest, ResolvedDelegation } from "../../src/contracts"
import type { HostPorts } from "../../src/host/execution"
import { authorizeParent, evaluateTaskRules } from "../../src/host/permissions"

const request: DelegationRequest = {
  projectID: "project",
  parentSessionID: "parent",
  taskID: "task",
  route: { kind: "agent", id: "worker" },
  prompt: "Work",
  skills: [],
  background: false,
}
const resolved: ResolvedDelegation = {
  agentID: "worker",
  prompt: "Work",
  skills: [],
  background: false,
}
type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }
function host(
  rules: Rule[],
  parent: Record<string, unknown> = {},
  sessionRules: Rule[] = [],
): HostPorts {
  return {
    session: {
      get: async () => ({
        id: "parent",
        projectID: "project",
        agent: "parent-agent",
        permissions: sessionRules,
        ...parent,
      }),
    },
    agent: { get: async () => ({ data: { permissions: rules } }) },
  } as unknown as HostPorts
}

describe("parent task authorization diagnostics", () => {
  test("V2 subagent rules authorize and override legacy task rules in order", async () => {
    expect(
      evaluateTaskRules([{ action: "subagent", resource: "work*", effect: "allow" }], "worker"),
    ).toBe("allow")
    expect(
      evaluateTaskRules(
        [
          { action: "task", resource: "*", effect: "allow" },
          { action: "subagent", resource: "worker", effect: "deny" },
        ],
        "worker",
      ),
    ).toBe("deny")
    await expect(
      authorizeParent(
        host([{ action: "subagent", resource: "worker", effect: "allow" }]),
        request,
        resolved,
      ),
    ).resolves.toBeUndefined()
    await expect(
      authorizeParent(
        host([{ action: "*", resource: "*", effect: "allow" }], {}, [
          { action: "subagent", resource: "worker", effect: "deny" },
        ]),
        request,
        resolved,
      ),
    ).rejects.toHaveProperty("code", "permission-denied")
  })
  test("identity failures are fail-closed and explain how to repair the parent context", async () => {
    for (const parent of [{ projectID: "other" }, { projectID: undefined }, { agent: undefined }]) {
      try {
        await authorizeParent(
          host([{ action: "task", resource: "*", effect: "allow" }], parent),
          request,
          resolved,
        )
        throw new Error("Authorization unexpectedly allowed")
      } catch (error) {
        expect(error).toHaveProperty("code", "permission-denied")
        expect((error as Error).message).toContain("action=subagent")
        expect((error as Error).message).toContain("resource=worker")
        expect((error as Error).message).toContain("effect=deny")
        expect((error as Error).message).toContain("Remediation:")
      }
    }
  })
  test("only explicit effective allow authorizes; session rules keep last-match precedence", async () => {
    expect(evaluateTaskRules([], "worker")).toBe("ask")
    expect(
      evaluateTaskRules([{ action: "subagent", resource: "work*", effect: "allow" }], "worker"),
    ).toBe("allow")
    expect(evaluateTaskRules([{ action: "shell", resource: "*", effect: "allow" }], "worker")).toBe(
      "ask",
    )
    await expect(
      authorizeParent(
        host([{ action: "subagent", resource: "*", effect: "allow" }]),
        request,
        resolved,
      ),
    ).resolves.toBeUndefined()
    for (const effect of ["ask", "deny"] as const) {
      await expect(
        authorizeParent(
          host([{ action: "subagent", resource: "*", effect: "allow" }], {}, [
            { action: "subagent", resource: "worker", effect },
          ]),
          request,
          resolved,
        ),
      ).rejects.toHaveProperty("code", "permission-denied")
    }
    await expect(authorizeParent(host([]), request, resolved)).rejects.toHaveProperty(
      "code",
      "permission-denied",
    )
  })
  test("ask and deny remain blocked with action, resource, effect and remediation", async () => {
    for (const effect of ["ask", "deny"] as const) {
      try {
        await authorizeParent(
          host([{ action: "subagent", resource: "worker", effect }]),
          request,
          resolved,
        )
        throw new Error("Authorization unexpectedly allowed")
      } catch (error) {
        expect(error).toHaveProperty("code", "permission-denied")
        const message = (error as Error).message
        expect(message).toContain("action=subagent")
        expect(message).toContain("resource=worker")
        expect(message).toContain(`effect=${effect}`)
        expect(message).toContain("Remediation:")
        expect(message).toContain(effect === "ask" ? "native task approval" : "denied")
      }
    }
  })
})
