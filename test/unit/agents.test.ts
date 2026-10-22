import { expect, test } from "bun:test"
import { Agent, type Plugin } from "@opencode/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { DeepMutable } from "@opencode/plugin/promise/types"
import { registerAgents } from "../../src/agents/registry"
import { resolveOptions } from "../../src/config/resolve"
import { parseOptions } from "../../src/config/schema"

function fixture(existing: string[] = []) {
  const records = new Map<string, Agent.Info>(
    existing.map((id) => [id, Agent.Info.default(id as Agent.ID)]),
  )
  interface FixtureAgentStore {
    get: (id: string) => Agent.Info | undefined
    update: (id: string, update: (agent: DeepMutable<Agent.Info>) => void) => void
  }
  const ctx = {
    session: { hook: async () => ({ dispose: async () => {} }) },
    permission: { hook: async () => ({ dispose: async () => {} }) },
    agent: {
      transform: async (apply: (store: FixtureAgentStore) => void) => {
        apply({
          get: (id: string) => records.get(id),
          update: (id: string, update: (agent: DeepMutable<Agent.Info>) => void) => {
            const agent = records.get(id) ?? Agent.Info.default(id as Agent.ID)
            update(agent as DeepMutable<Agent.Info>)
            records.set(id, agent)
          },
        })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context
  return { ctx, records }
}

const defaults = resolveOptions(parseOptions({ schemaVersion: 1 }))

test("augments the standard host explore role while preserving its existing restrictions", async () => {
  const { ctx, records } = fixture(["explore"])
  const explore = records.get("explore") as DeepMutable<Agent.Info> | undefined
  if (!explore) throw new Error("fixture is missing the explore agent")
  explore.mode = "subagent"
  explore.description =
    'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.'
  explore.permissions.push({ action: "external_directory", resource: "*", effect: "deny" })
  await registerAgents(ctx, defaults)
  expect(records.size).toBe(17)
  // Consultation prompts must not instruct delegation the host then denies.
  expect(explore.system ?? "").toContain("read-only")
  expect(explore.system ?? "").not.toContain("omo_delegate")
  expect(explore.system ?? "").not.toContain("skill catalog")
  expect(explore.system ?? "").not.toContain("omo.parallel")
  expect(explore.system ?? "").not.toContain("omo compact")
  expect(explore.permissions).toContainEqual({
    action: "external_directory",
    resource: "*",
    effect: "deny",
  })
})

test("effective host models cannot bypass a primary agent's model allowlist", async () => {
  const { ctx } = fixture()
  interface ModelGateCall {
    agent: string
    model: { providerID: string; id: string }
  }
  let request: (input: ModelGateCall) => void = () => {
    throw new Error("model.request hook was not installed")
  }
  let disposed = 0
  const guarded = {
    ...ctx,
    session: {
      ...ctx.session,
      hook: async (_name: string, callback: (input: ModelGateCall) => void) => {
        request = callback
        return {
          dispose: async () => {
            disposed++
          },
        }
      },
    },
  } as unknown as Plugin.Context
  const cleanup = await registerAgents(
    guarded,
    resolveOptions(
      parseOptions({
        schemaVersion: 1,
        agents: { sisyphus: { allowedModels: ["test/approved"] } },
      }),
    ),
  )
  expect(request).toBeFunction()
  expect(() => request({ agent: "sisyphus", model: { providerID: "test", id: "other" } })).toThrow()
  expect(() =>
    request({ agent: "sisyphus", model: { providerID: "test", id: "approved" } }),
  ).not.toThrow()
  expect(() =>
    request({ agent: "user-agent", model: { providerID: "test", id: "other" } }),
  ).not.toThrow()
  await cleanup()
  await cleanup()
  expect(disposed).toBe(1)
})

test("registers seven unprefixed task profiles with one read-only explorer", async () => {
  const { ctx, records } = fixture()
  await registerAgents(ctx, defaults)
  expect([...records.keys()].slice(0, 7)).toEqual([
    "orchestrator",
    "planner",
    "executor",
    "explore",
    "researcher",
    "reviewer",
    "verifier",
  ])
  for (const [id, agent] of [...records].slice(0, 7)) {
    expect(agent.mode).toBe("subagent")
    expect(agent.system).toContain("Evidence")
    if (id !== "executor") {
      expect(agent.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
      expect(agent.permissions).toContainEqual({ action: "shell", resource: "*", effect: "deny" })
    }
  }
  expect(records.get("executor")?.permissions).toEqual(
    Agent.Info.default("probe" as Agent.ID).permissions,
  )
  expect([...records.keys()].filter((id) => id === "explore")).toEqual(["explore"])
  expect([...records.keys()].some((id) => id.startsWith("omo-"))).toBe(false)
  expect(records.get("explore")?.permissions).toContainEqual({
    action: "subagent",
    resource: "*",
    effect: "deny",
  })
  expect(records.get("explore")?.system).toContain("callers, dependencies, data flow and tests")
  expect(records.get("explore")?.system).not.toContain("omo_delegate")
  expect(records.get("explore")?.system).not.toContain("omo_parallel")
})

test("upstream roles remain selectable alongside the consolidated task profiles", async () => {
  const { ctx, records } = fixture()
  await registerAgents(ctx, defaults)
  for (const id of ["sisyphus", "hephaestus", "prometheus", "atlas"]) {
    expect(records.get(id)?.mode).toBe("primary")
  }
  for (const id of [
    "oracle",
    "librarian",
    "explore",
    "multimodal-looker",
    "metis",
    "momus",
    "sisyphus-junior",
  ]) {
    expect(records.get(id)?.mode).toBe("subagent")
  }
  expect(records.size).toBe(17)
  expect(records.get("oracle")?.permissions).toContainEqual({
    action: "edit",
    resource: "*",
    effect: "deny",
  })
  // Consultation roles also lose the ability to delegate (upstream parity).
  for (const id of ["oracle", "librarian", "explore", "metis", "momus"]) {
    const permissions = records.get(id)?.permissions ?? []
    expect(permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
    expect(permissions).toContainEqual({ action: "shell", resource: "*", effect: "deny" })
    expect(permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
  }
  // The media analyst is restricted to reading.
  const looker = records.get("multimodal-looker")?.permissions ?? []
  expect(looker).toContainEqual({ action: "*", resource: "*", effect: "deny" })
  expect(looker).toContainEqual({ action: "read", resource: "*", effect: "allow" })
  // The bounded junior executor keeps write access but never re-delegates.
  const junior = records.get("sisyphus-junior")?.permissions ?? []
  expect(junior).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
  expect(junior).toContainEqual({ action: "consult", resource: "*", effect: "allow" })
  expect(junior).not.toContainEqual({ action: "edit", resource: "*", effect: "deny" })
  // Metis may spawn read-only consultations with explore or librarian.
  const metisPermissions = records.get("metis")?.permissions ?? []
  expect(metisPermissions).toContainEqual({ action: "consult", resource: "*", effect: "allow" })
  expect(metisPermissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
  // Prometheus plans: only .md files may be written; shell stays denied.
  const prometheusPermissions = records.get("prometheus")?.permissions ?? []
  expect(prometheusPermissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
  expect(prometheusPermissions).toContainEqual({
    action: "edit",
    resource: "*.md",
    effect: "allow",
  })
  expect(prometheusPermissions).toContainEqual({ action: "shell", resource: "*", effect: "deny" })
  // Atlas keeps delegation to coordinate plan execution (upstream grants task).
  const atlas = records.get("atlas")?.permissions ?? []
  expect(atlas).not.toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
  expect(atlas).not.toContainEqual({ action: "edit", resource: "*", effect: "deny" })
})

test("read-only evaluation denies shell despite inherited allow and leaves unrelated agents alone", async () => {
  const { ctx } = fixture()
  // The evaluate hook speaks the host payload type (branded IDs included);
  // the helper builds complete payloads from widened strings so no cast
  // claims a shape the double never builds.
  function evaluation(
    agent: string | undefined,
    action: string | undefined,
    resources: string[] = ["*"],
  ): PermissionEvaluation {
    if (agent === undefined) throw new Error("evaluation requires an agent")
    if (action === undefined) throw new Error("evaluation requires an action")
    const sessionID: string = "ses-test"
    return {
      sessionID: sessionID as PermissionEvaluation["sessionID"],
      agent: agent as PermissionEvaluation["agent"],
      action,
      resources,
      effect: "allow",
    }
  }
  let evaluate: (input: PermissionEvaluation) => unknown = () => {
    throw new Error("permission evaluate hook was not installed")
  }
  let disposals = 0
  const guardedCtx: Plugin.Context = {
    ...ctx,
    permission: {
      ...ctx.permission,
      hook: async (_name, callback) => {
        evaluate = callback
        return {
          dispose: async () => {
            disposals++
          },
        }
      },
    },
  }
  const cleanup = await registerAgents(guardedCtx, defaults)
  for (const action of ["shell", "edit"]) {
    const input = evaluation("explore", action)
    await evaluate(input)
    expect(input.effect).toBe("deny")
  }
  // Consultation roles never delegate; the bounded junior executor never re-delegates.
  for (const agent of ["oracle", "librarian", "explore", "metis", "momus", "sisyphus-junior"]) {
    for (const action of ["subagent", "task"]) {
      const input = evaluation(agent, action)
      await evaluate(input)
      expect(input.effect).toBe("deny")
    }
  }
  // The media analyst may only read.
  const lookerRead = evaluation("multimodal-looker", "read")
  await evaluate(lookerRead)
  expect(lookerRead.effect).toBe("allow")
  for (const action of ["shell", "edit", "subagent", "grep", "write"]) {
    const input = evaluation("multimodal-looker", action)
    await evaluate(input)
    expect(input.effect).toBe("deny")
  }
  // Prometheus writes only markdown plans and never runs shell.
  const planEdit = evaluation("prometheus", "edit", ["docs/plan.md"])
  await evaluate(planEdit)
  expect(planEdit.effect).toBe("allow")
  const codeEdit = evaluation("prometheus", "edit", ["src/app.ts"])
  await evaluate(codeEdit)
  expect(codeEdit.effect).toBe("deny")
  const prometheusShell = evaluation("prometheus", "shell")
  await evaluate(prometheusShell)
  expect(prometheusShell.effect).toBe("deny")
  // Writers and coordinators keep their capabilities.
  for (const [agent, action] of [
    ["executor", "shell"],
    ["user-reader", "edit"],
    ["explore", "read"],
    ["atlas", "subagent"],
    ["sisyphus", "subagent"],
    ["prometheus", "subagent"],
    ["sisyphus-junior", "edit"],
  ]) {
    const input = evaluation(agent, action)
    await evaluate(input)
    expect(input.effect).toBe("allow")
  }
  await cleanup()
  await cleanup()
  expect(disposals).toBe(1)
})

for (const id of ["reviewer", "explore"]) {
  test(`an existing custom ${id} rejects registration without changing user agents`, async () => {
    const { ctx, records } = fixture([id])
    const original = structuredClone(records.get(id))
    await expect(registerAgents(ctx, defaults)).rejects.toMatchObject({ code: "agent-collision" })
    expect([...records.keys()]).toEqual([id])
    expect(records.get(id)).toEqual(original)
  })
}

test("configured models retain variants; custom consultation profiles remain read-only", async () => {
  const { ctx, records } = fixture()
  const options = resolveOptions(
    parseOptions({
      schemaVersion: 1,
      profiles: [
        {
          id: "executor",
          allowWrite: true,
          model: { providerID: "openai", modelID: "test-model", variant: "high" },
        },
        { id: "team-reader", allowWrite: false },
      ],
    }),
  )
  await registerAgents(ctx, options)
  const model = records.get("executor")?.model
  expect(model?.providerID as string).toBe("openai")
  expect(model?.id as string).toBe("test-model")
  expect(model?.variant as string).toBe("high")
  expect(records.get("team-reader")?.permissions.slice(-2)).toEqual([
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
  ])
  // Consultation systems resolve by profile ID, not array position.
  expect(records.get("team-reader")?.system).toBe(records.get("explore")?.system)
  expect(records.get("executor")?.system).toContain("repository conventions")
})

test("parity agent overrides preserve its primary role and writer permissions when only model is configured", async () => {
  const { ctx, records } = fixture()
  await registerAgents(
    ctx,
    resolveOptions(
      parseOptions({
        schemaVersion: 1,
        agents: {
          sisyphus: { model: "test/solver#high" },
          oracle: { allowWrite: true },
          explore: { allowWrite: true },
        },
      }),
    ),
  )
  expect(records.get("sisyphus")?.mode).toBe("primary")
  expect(records.get("sisyphus")?.model?.variant as string).toBe("high")
  expect(records.get("sisyphus")?.permissions).toEqual(
    Agent.Info.default("probe" as Agent.ID).permissions,
  )
  // Configuration cannot expand a consultation role's write authority.
  expect(records.get("oracle")?.permissions).toContainEqual({
    action: "edit",
    resource: "*",
    effect: "deny",
  })
  for (const action of ["edit", "shell", "subagent"])
    expect(records.get("explore")?.permissions).toContainEqual({
      action,
      resource: "*",
      effect: "deny",
    })
})

test("an explore profile override cannot grant write or delegation authority", async () => {
  const { ctx, records } = fixture()
  await registerAgents(
    ctx,
    resolveOptions(
      parseOptions({ schemaVersion: 1, profiles: [{ id: "explore", allowWrite: true }] }),
    ),
  )
  for (const action of ["edit", "shell", "subagent"])
    expect(records.get("explore")?.permissions).toContainEqual({
      action,
      resource: "*",
      effect: "deny",
    })
})

test("permission-hook setup failure disposes the registration instead of leaving unguarded agents", async () => {
  const { ctx } = fixture()
  let disposed = 0
  const transform = ctx.agent.transform
  const failingCtx: Plugin.Context = {
    ...ctx,
    agent: {
      ...ctx.agent,
      transform: async (callback) => {
        await transform(callback)
        return {
          dispose: async () => {
            disposed++
          },
        }
      },
    },
    permission: {
      ...ctx.permission,
      hook: async () => {
        throw new Error("hook unavailable")
      },
    },
  }
  await expect(registerAgents(failingCtx, defaults)).rejects.toThrow("hook unavailable")
  expect(disposed).toBe(1)
})
