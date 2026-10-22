import { describe, expect, mock, test } from "bun:test"
import { resolveOptions } from "../../src/config/resolve.js"
import { parseOptions } from "../../src/config/schema.js"
import type { DelegationRequest, ResolvedDelegation } from "../../src/contracts.js"
import { createRunEventTracker } from "../../src/host/events.js"
import type {
  HostAgentRecord,
  HostPorts,
  HostSessionPort,
  HostSessionRecord,
} from "../../src/host/execution.js"
import { createExecutionAdapter, ExecutionError } from "../../src/host/execution.js"

// Seam pública T04: createExecutionAdapter(host, options) com doubles do host.
// launch, inspect e cancel são observados somente pela interface pública.

const options = resolveOptions(parseOptions({ schemaVersion: 1 }))

function request(): DelegationRequest {
  return {
    projectID: "prj_test",
    parentSessionID: "ses_parent",
    taskID: "task_1",
    route: { kind: "agent", id: "omo-spike-alpha" },
    prompt: "reply ALPHA-OK",
    skills: [],
    background: false,
  }
}

function resolved(): ResolvedDelegation {
  return {
    agentID: "omo-spike-alpha",
    skills: [],
    prompt: "reply ALPHA-OK",
    background: false,
  }
}

function agentRecord(): { data: HostAgentRecord } {
  return { data: { id: "omo-spike-alpha", mode: "subagent", permissions: [] } }
}

function agentWithPermissions(permissions: HostAgentRecord["permissions"]): {
  data: HostAgentRecord
} {
  return { data: { id: "omo-spike-alpha", mode: "subagent", permissions } }
}

type CreateInput = Parameters<HostSessionPort["create"]>[0]
type SwitchModelInput = Parameters<HostSessionPort["switchModel"]>[0]
type PromptInput = Parameters<HostSessionPort["prompt"]>[0]
type InterruptInput = Parameters<HostSessionPort["interrupt"]>[0]

const noSkills: HostPorts["skill"] = { list: async () => ({ data: [] }) }

function parentRecord(id = "ses_parent"): HostSessionRecord {
  return { id }
}

describe("execution admission lifecycle", () => {
  test.each([
    {
      name: "new child depth",
      sessionID: undefined,
      parentID: "ses_parent",
      agent: "omo-spike-alpha",
      depth: 1,
      code: "depth-exceeded",
    },
    {
      name: "foreign continuation parent",
      sessionID: "ses_child1",
      parentID: "ses_other",
      agent: "omo-spike-alpha",
      depth: 1,
      code: "foreign-session",
    },
    {
      name: "foreign continuation agent",
      sessionID: "ses_child1",
      parentID: "ses_parent",
      agent: "other-agent",
      depth: 1,
      code: "foreign-session",
    },
    {
      name: "continuation depth",
      sessionID: "ses_child1",
      parentID: "ses_parent",
      agent: "omo-spike-alpha",
      depth: 2,
      code: "depth-exceeded",
    },
    {
      name: "missing continuation",
      sessionID: "ses_missing",
      parentID: "ses_parent",
      agent: "omo-spike-alpha",
      depth: 1,
      code: "unknown-session",
    },
  ])("$name rejection records no intent or host mutation", async (scenario) => {
    const lifecycle = {
      intent: mock(async () => {}),
      prepared: mock(async () => {}),
    }
    const host: HostPorts = {
      session: {
        get: async () => {
          if (scenario.sessionID === "ses_missing") throw new Error("session missing")
          return {
            id: scenario.sessionID ?? "ses_parent",
            parentID: scenario.parentID,
            agent: scenario.agent,
            metadata: { "omo.depth": scenario.depth },
          }
        },
        create: mock(async () => ({ id: "ses_new" })),
        switchModel: mock(async () => {}),
        prompt: mock(async () => ({})),
        wait: mock(async () => {}),
        interrupt: mock(async () => ({})),
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    const limited = { ...options, execution: { ...options.execution, maxDepth: 1 } }
    await expect(
      createExecutionAdapter(host, limited, undefined, lifecycle).launch(
        request(),
        {
          ...resolved(),
          sessionID: scenario.sessionID,
          background: true,
          model: { providerID: "provider_test", modelID: "model_test" },
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: scenario.code })
    expect(lifecycle.intent).not.toHaveBeenCalled()
    expect(lifecycle.prepared).not.toHaveBeenCalled()
    expect(host.session.create).not.toHaveBeenCalled()
    expect(host.session.switchModel).not.toHaveBeenCalled()
    expect(host.session.prompt).not.toHaveBeenCalled()
    expect(host.session.interrupt).not.toHaveBeenCalled()
  })

  test.each([false, true])(
    "intent precedes ambiguous host admission (continuation=%s)",
    async (continuation) => {
      const order: string[] = []
      const lifecycle = {
        intent: mock(async () => {
          order.push("intent")
        }),
        prepared: mock(async () => {}),
      }
      const host: HostPorts = {
        session: {
          get: async () => {
            order.push("validation")
            return { id: "ses_child1", parentID: "ses_parent", agent: "omo-spike-alpha" }
          },
          create: mock(async () => {
            order.push("create")
            throw new Error("ambiguous create")
          }),
          switchModel: mock(async () => {
            order.push("model")
            throw new Error("ambiguous model change")
          }),
          prompt: mock(async () => ({})),
          wait: mock(async () => {}),
          interrupt: mock(async () => ({})),
        },
        agent: { get: async () => agentRecord() },
        skill: noSkills,
      }
      await expect(
        createExecutionAdapter(host, options, undefined, lifecycle).launch(
          request(),
          {
            ...resolved(),
            background: true,
            ...(continuation ? { sessionID: "ses_child1" } : {}),
            model: { providerID: "provider_test", modelID: "model_test" },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(continuation ? "cannot apply model" : "ambiguous create")
      expect(order).toEqual(["validation", "intent", continuation ? "model" : "create"])
      expect(lifecycle.intent).toHaveBeenCalledTimes(1)
      expect(lifecycle.prepared).not.toHaveBeenCalled()
      expect(host.session.create).toHaveBeenCalledTimes(continuation ? 0 : 1)
      expect(host.session.prompt).not.toHaveBeenCalled()
    },
  )
})

describe("execution launch (foreground, nova sessão)", () => {
  test("declared write ownership reaches the child prompt", async () => {
    const prompt = mock(async (_input: PromptInput) => ({}))
    const host: HostPorts = {
      session: {
        create: async () => ({ id: "owned-child" }),
        get: async () => parentRecord(),
        prompt,
        wait: async () => {},
        switchModel: async () => {},
        interrupt: async () => ({}),
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    await createExecutionAdapter(host, options).launch(
      { ...request(), files: ["src/owned.ts"] },
      { ...resolved(), background: true },
      new AbortController().signal,
    )
    const firstPrompt = prompt.mock.calls[0]?.[0]
    expect(firstPrompt?.text).toContain("src/owned.ts")
    expect(firstPrompt?.text).toContain("reply ALPHA-OK")
  })
  test("new and continued children see their persisted depth budget", async () => {
    const prompts: string[] = []
    let child: HostSessionRecord | undefined
    const host: HostPorts = {
      session: {
        create: async (input: CreateInput) => {
          child = { id: "depth-child", parentID: input.parentID, metadata: input.metadata }
          return child
        },
        get: async ({ sessionID }: { sessionID: string }) =>
          sessionID === "depth-child" ? (child ?? parentRecord()) : parentRecord(),
        prompt: async ({ text }: { sessionID: string; text: string }) => {
          prompts.push(text)
        },
        wait: async () => {},
        switchModel: async () => {},
        interrupt: async () => ({}),
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    const adapter = createExecutionAdapter(
      host,
      resolveOptions(parseOptions({ schemaVersion: 1, execution: { maxDepth: 3 } })),
    )
    await adapter.launch(
      request(),
      { ...resolved(), background: true },
      new AbortController().signal,
    )
    await adapter.launch(
      request(),
      { ...resolved(), background: true, sessionID: "depth-child" },
      new AbortController().signal,
    )
    expect(prompts).toEqual(["[omo depth 1/3] reply ALPHA-OK", "[omo depth 1/3] reply ALPHA-OK"])
  })
  test("host without native parentID retains owned admission association", async () => {
    let child: HostSessionRecord | undefined
    const host: HostPorts = {
      session: {
        create: async (input: CreateInput) => {
          child = { id: "ses_child1", metadata: input.metadata }
          return child
        },
        get: async ({ sessionID }: { sessionID: string }) =>
          sessionID === "ses_child1" ? (child ?? parentRecord("ses_child1")) : parentRecord(),
        prompt: async () => {},
        wait: async () => {},
        switchModel: async () => {},
        interrupt: async () => ({}),
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    const adapter = createExecutionAdapter(host, options)
    await adapter.launch(
      request(),
      { ...resolved(), background: true },
      new AbortController().signal,
    )
    expect(child?.metadata?.["omo.parentSessionID"]).toBe("ses_parent")
    await expect(adapter.adopt("ses_child1", "ses_parent")).resolves.toBeUndefined()
    await expect(adapter.adopt("ses_child1", "ses_other")).rejects.toHaveProperty(
      "code",
      "foreign-session",
    )
    if (!child?.metadata) throw new Error("child session was not created")
    delete child.metadata["omo.parentSessionID"]
    const recordedAttempt = child.metadata["omo.attemptID"]
    const recordedAttemptID = typeof recordedAttempt === "string" ? recordedAttempt : undefined
    await expect(
      adapter.adopt("ses_child1", "ses_parent", recordedAttemptID),
    ).resolves.toBeUndefined()
    await expect(
      adapter.adopt("ses_child1", "ses_parent", "foreign-attempt"),
    ).rejects.toHaveProperty("code", "foreign-session")
    child.parentID = "ses_other"
    await expect(
      adapter.adopt("ses_child1", "ses_parent", recordedAttemptID),
    ).rejects.toHaveProperty("code", "foreign-session")
  })
  test("eventos emitidos durante admissão já pertencem à tentativa retornada", async () => {
    const tracker = createRunEventTracker()
    let observed: ReturnType<typeof tracker.accept>
    const host: HostPorts = {
      session: {
        create: async () => ({ id: "ses_child1" }),
        get: async () => parentRecord(),
        prompt: async () => {
          observed = tracker.accept({
            id: "host-start",
            type: "session.execution.started",
            data: { sessionID: "ses_child1" },
            durable: { seq: 1 },
          })
        },
        wait: async () => {},
        switchModel: async () => {},
        interrupt: async () => ({}),
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    const handle = await createExecutionAdapter(host, options, tracker).launch(
      request(),
      { ...resolved(), background: true },
      new AbortController().signal,
    )
    expect(observed).toEqual({
      attemptID: handle.attemptID,
      sessionID: "ses_child1",
      state: "running",
      eventID: "host-start",
    })
  })
  test("skill inexistente falha antes de criar filha ou admitir prompt", async () => {
    const create = mock(async () => ({ id: "ses_child1" }))
    const prompt = mock(async () => ({}))
    const host: HostPorts = {
      session: {
        create,
        get: async () => parentRecord(),
        prompt,
        wait: async () => {},
        switchModel: async () => {},
        interrupt: async () => ({}),
      },
      agent: { get: async () => agentRecord() },
      skill: { list: async () => ({ data: [] }) },
    }
    await expect(
      createExecutionAdapter(host, options).launch(
        request(),
        {
          ...resolved(),
          background: true,
          skills: ["missing"],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "unknown-skill" })
    expect(create).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  })

  test("skills resolvidas usam IDs e nomes do catálogo no prompt nativo", async () => {
    const prompt = mock(async (_input: PromptInput) => ({}))
    const host: HostPorts = {
      session: {
        create: async () => ({ id: "ses_child1" }),
        get: async () => parentRecord(),
        prompt,
        wait: async () => {},
        switchModel: async () => {},
        interrupt: async () => ({}),
      },
      agent: { get: async () => agentRecord() },
      skill: { list: async () => ({ data: [{ id: "skill_review", name: "review" }] }) },
    }
    await createExecutionAdapter(host, options).launch(
      request(),
      {
        ...resolved(),
        background: true,
        skills: ["review"],
      },
      new AbortController().signal,
    )
    expect(prompt.mock.calls[0]?.[0]).toEqual({
      sessionID: "ses_child1",
      text: "reply ALPHA-OK",
      skills: [{ id: "skill_review", name: "review" }],
    })
  })

  test("continuação aplica modelo antes do prompt e propaga rejeição sem fallback", async () => {
    const order: string[] = []
    const prompt = mock(async () => {
      order.push("prompt")
      return {}
    })
    const switchModel = mock(async (input: SwitchModelInput) => {
      order.push("model")
      if (input.model.id === "missing") throw new Error("model unavailable")
    })
    const host: HostPorts = {
      session: {
        create: async () => ({ id: "ses_new" }),
        get: async () => ({ id: "ses_child1", parentID: "ses_parent" }),
        prompt,
        switchModel,
        wait: async () => {},
        interrupt: async () => ({}),
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    const adapter = createExecutionAdapter(host, options)
    const continuation = {
      ...resolved(),
      sessionID: "ses_child1",
      background: true,
      model: { providerID: "provider_test", modelID: "model_test" },
    }
    await adapter.launch(request(), continuation, new AbortController().signal)
    expect(order).toEqual(["model", "prompt"])
    expect(switchModel.mock.calls[0]?.[0]).toEqual({
      sessionID: "ses_child1",
      model: { providerID: "provider_test", id: "model_test" },
    })
    await expect(
      adapter.launch(
        request(),
        { ...continuation, model: { providerID: "provider_test", modelID: "missing" } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "host-error" })
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  test("modelo resolvido é aplicado ao criar a filha sem substituição", async () => {
    const create = mock(async (_input: CreateInput) => ({ id: "ses_child1" }))
    const host: HostPorts = {
      session: {
        create,
        get: async () => parentRecord(),
        prompt: async () => ({}),
        wait: async () => {},
        switchModel: async () => {},
        interrupt: async () => ({}),
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    await createExecutionAdapter(host, options).launch(
      request(),
      {
        ...resolved(),
        background: true,
        model: { providerID: "provider_test", modelID: "model_test", variant: "high" },
      },
      new AbortController().signal,
    )
    const createModel = create.mock.calls[0]?.[0]?.model
    expect(createModel).toEqual({
      providerID: "provider_test",
      id: "model_test",
      variant: "high",
    })
  })

  test("cria sessão filha com parentID/agente, admite prompt, espera e retorna handle completed", async () => {
    const create = mock(async (_input: CreateInput) => ({
      id: "ses_child1",
      parentID: "ses_parent",
      projectID: "prj_test",
      agent: "omo-spike-alpha",
    }))
    const prompt = mock(async (_input: { sessionID: string; text: string }) => ({ id: "msg_1" }))
    const wait = mock(async () => {})
    const get = mock(
      async (): Promise<HostSessionRecord> => ({
        id: "ses_child1",
        outcome: "succeeded",
      }),
    )
    const host: HostPorts = {
      session: {
        create,
        get,
        prompt,
        wait,
        switchModel: async () => {},
        interrupt: mock(async () => ({})),
      },
      agent: { get: mock(async () => agentRecord()) },
      skill: noSkills,
    }

    const adapter = createExecutionAdapter(host, options)
    const handle = await adapter.launch(request(), resolved(), new AbortController().signal)

    expect(create).toHaveBeenCalledTimes(1)
    const createInput = create.mock.calls[0]?.[0]
    expect(createInput).toMatchObject({ parentID: "ses_parent", agent: "omo-spike-alpha" })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ sessionID: "ses_child1" })
    expect(wait).toHaveBeenCalledTimes(1)
    expect(handle.sessionID).toBe("ses_child1")
    expect(handle.state).toBe("completed")
    expect(typeof handle.attemptID).toBe("string")
    expect(handle.attemptID.length).toBeGreaterThan(0)
  })

  test("agente desconhecido recusa antes de criar sessão", async () => {
    const create = mock(async () => ({ id: "ses_child1" }))
    const host: HostPorts = {
      session: {
        create,
        get: mock(async () => parentRecord()),
        prompt: mock(async () => ({})),
        wait: mock(async () => {}),
        switchModel: mock(async () => {}),
        interrupt: mock(async () => ({})),
      },
      agent: {
        get: mock(async () => {
          throw new Error("agent not found: omo-spike-ghost")
        }),
      },
      skill: noSkills,
    }

    const adapter = createExecutionAdapter(host, options)
    const error = await adapter
      .launch(
        request(),
        { ...resolved(), agentID: "omo-spike-ghost" },
        new AbortController().signal,
      )
      .catch((e) => e)
    expect(error?.code).toBe("unknown-agent")
    expect(create).not.toHaveBeenCalled()
  })

  test("agente primary recusa antes de criar sessão", async () => {
    const create = mock(async () => ({ id: "ses_child1" }))
    const host: HostPorts = {
      session: {
        create,
        get: mock(async () => parentRecord()),
        prompt: mock(async () => ({})),
        wait: mock(async () => {}),
        switchModel: mock(async () => {}),
        interrupt: mock(async () => ({})),
      },
      agent: {
        get: mock(
          async (): Promise<{ data: HostAgentRecord }> => ({
            data: { id: "omo-spike-alpha", mode: "primary", permissions: [] },
          }),
        ),
      },
      skill: noSkills,
    }

    const adapter = createExecutionAdapter(host, options)
    const error = await adapter
      .launch(request(), resolved(), new AbortController().signal)
      .catch((e) => e)
    expect(error?.code).toBe("primary-agent")
    expect(create).not.toHaveBeenCalled()
  })

  test("restrições do filho não impedem o pai autorizado de chamá-lo", async () => {
    const create = mock(async () => ({ id: "ses_child1" }))
    const host: HostPorts = {
      session: {
        create,
        get: mock(
          async (): Promise<HostSessionRecord> => ({ id: "ses_child1", outcome: "succeeded" }),
        ),
        prompt: mock(async () => ({})),
        wait: mock(async () => {}),
        switchModel: mock(async () => {}),
        interrupt: mock(async () => ({})),
      },
      agent: {
        get: mock(async () =>
          agentWithPermissions([
            { action: "*", resource: "*", effect: "deny" },
            { action: "read", resource: "*", effect: "allow" },
            { action: "subagent", resource: "*", effect: "deny" },
          ]),
        ),
      },
      skill: noSkills,
    }

    const authorize = mock(async () => {})
    const adapter = createExecutionAdapter(host, options, undefined, {
      intent: async () => {},
      prepared: async () => {},
      authorize,
    })
    const handle = await adapter.launch(request(), resolved(), new AbortController().signal)
    expect(handle.sessionID).toBe("ses_child1")
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
    const denied = createExecutionAdapter(host, options, undefined, {
      intent: async () => {},
      prepared: async () => {},
      authorize: async () => {
        throw new ExecutionError("permission-denied", "parent denied subagent")
      },
    })
    await expect(
      denied.launch(request(), resolved(), new AbortController().signal),
    ).rejects.toThrow("parent denied subagent")
    expect(create).toHaveBeenCalledTimes(1)
  })

  test("background retorna running sem aguardar conclusão", async () => {
    const create = mock(async () => ({ id: "ses_child1" }))
    const prompt = mock(async () => ({}))
    const wait = mock(async () => {})
    const host: HostPorts = {
      session: {
        create,
        get: mock(async () => parentRecord()),
        prompt,
        wait,
        switchModel: mock(async () => {}),
        interrupt: mock(async () => ({})),
      },
      agent: { get: mock(async () => agentRecord()) },
      skill: noSkills,
    }

    const adapter = createExecutionAdapter(host, options)
    const handle = await adapter.launch(
      { ...request(), background: true },
      { ...resolved(), background: true },
      new AbortController().signal,
    )

    expect(handle.sessionID).toBe("ses_child1")
    expect(handle.state).toBe("running")
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })

  test("continuação admite prompt na sessão existente sem criar nova", async () => {
    const create = mock(async () => ({ id: "ses_other" }))
    const prompt = mock(async (_input: PromptInput) => ({}))
    const wait = mock(async () => {})
    const host: HostPorts = {
      session: {
        create,
        get: mock(
          async (): Promise<HostSessionRecord> => ({
            id: "ses_child1",
            parentID: "ses_parent",
            outcome: "succeeded",
            metadata: {},
          }),
        ),
        prompt,
        wait,
        switchModel: mock(async () => {}),
        interrupt: mock(async () => ({})),
      },
      agent: { get: mock(async () => agentRecord()) },
      skill: noSkills,
    }

    const adapter = createExecutionAdapter(host, options)
    const handle = await adapter.launch(
      request(),
      { ...resolved(), sessionID: "ses_child1" },
      new AbortController().signal,
    )

    expect(create).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ sessionID: "ses_child1" })
    expect(wait).toHaveBeenCalledTimes(1)
    expect(handle.sessionID).toBe("ses_child1")
    expect(handle.state).toBe("completed")
  })

  test("continuação de sessão de outro pai é recusada", async () => {
    const prompt = mock(async () => ({}))
    const host: HostPorts = {
      session: {
        create: mock(async () => ({ id: "ses_x" })),
        get: mock(async () => ({ id: "ses_child1", parentID: "ses_other", metadata: {} })),
        prompt,
        wait: mock(async () => {}),
        switchModel: mock(async () => {}),
        interrupt: mock(async () => ({})),
      },
      agent: { get: mock(async () => agentRecord()) },
      skill: noSkills,
    }

    const adapter = createExecutionAdapter(host, options)
    const error = await adapter
      .launch(request(), { ...resolved(), sessionID: "ses_child1" }, new AbortController().signal)
      .catch((e) => e)
    expect(error?.code).toBe("foreign-session")
    expect(prompt).not.toHaveBeenCalled()
  })

  test("continuação de sessão inexistente é recusada", async () => {
    const prompt = mock(async () => ({}))
    const host: HostPorts = {
      session: {
        create: mock(async () => ({ id: "ses_x" })),
        get: mock(async () => {
          throw new Error("session not found: ses_ghost")
        }),
        prompt,
        wait: mock(async () => {}),
        switchModel: mock(async () => {}),
        interrupt: mock(async () => ({})),
      },
      agent: { get: mock(async () => agentRecord()) },
      skill: noSkills,
    }

    const adapter = createExecutionAdapter(host, options)
    const error = await adapter
      .launch(request(), { ...resolved(), sessionID: "ses_ghost" }, new AbortController().signal)
      .catch((e) => e)
    expect(error?.code).toBe("unknown-session")
    expect(prompt).not.toHaveBeenCalled()
  })

  test("profundidade além de maxDepth recusa antes de criar sessão", async () => {
    const create = mock(async () => ({ id: "ses_child1" }))
    const host: HostPorts = {
      session: {
        create,
        get: mock(async () => ({ id: "ses_parent", metadata: { "omo.depth": 1 } })),
        prompt: mock(async () => ({})),
        wait: mock(async () => {}),
        switchModel: mock(async () => {}),
        interrupt: mock(async () => ({})),
      },
      agent: { get: mock(async () => agentRecord()) },
      skill: noSkills,
    }

    const limited = { ...options, execution: { ...options.execution, maxDepth: 1 } }
    const adapter = createExecutionAdapter(host, limited)
    const error = await adapter
      .launch(request(), resolved(), new AbortController().signal)
      .catch((e) => e)
    expect(error?.code).toBe("depth-exceeded")
    expect(create).not.toHaveBeenCalled()
  })
})

describe("execution inspect", () => {
  test("foreground com outcome failed não anuncia completed", async () => {
    const host: HostPorts = {
      session: {
        create: async () => ({ id: "ses_child1", parentID: "ses_parent" }),
        get: async ({ sessionID }: { sessionID: string }): Promise<HostSessionRecord> =>
          sessionID === "ses_parent"
            ? { id: sessionID, metadata: {} }
            : { id: sessionID, outcome: "failed" },
        prompt: async () => ({}),
        wait: async () => {},
        switchModel: async () => {},
        interrupt: async () => ({}),
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    const adapter = createExecutionAdapter(host, options)
    await expect(
      adapter.launch(request(), resolved(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "host-error" })
  })

  test.each([
    ["succeeded", "completed"],
    ["failed", "failed"],
    ["interrupted", "cancelled"],
    [undefined, "running"],
  ] as const)("outcome %s corresponde a %s", async (outcome, state) => {
    const host: HostPorts = {
      session: {
        create: async () => ({ id: "ses_unused" }),
        get: async () => ({ id: "ses_child1", outcome }),
        prompt: async () => ({}),
        wait: async () => {},
        switchModel: async () => {},
        interrupt: async () => ({}),
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    const adapter = createExecutionAdapter(host, options)
    expect(await adapter.inspect("ses_child1")).toEqual({ state })
  })

  test("sessão inacessível retorna unknown sem admitir trabalho", async () => {
    const create = mock(async () => ({ id: "ses_x" }))
    const host: HostPorts = {
      session: {
        create,
        get: async () => {
          throw new Error("session unavailable")
        },
        prompt: async () => ({}),
        wait: async () => {},
        switchModel: async () => {},
        interrupt: async () => ({}),
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    const adapter = createExecutionAdapter(host, options)
    expect(await adapter.inspect("ses_missing")).toEqual({ state: "unknown" })
    expect(create).not.toHaveBeenCalled()
  })
})

describe("execution cancel", () => {
  test("abort durante prompt pendente interrompe filha sem esperar resposta do host", async () => {
    const controller = new AbortController()
    let entered!: () => void
    const prompting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const interrupt = mock(async (_input: InterruptInput) => ({}))
    const host: HostPorts = {
      session: {
        create: async () => ({ id: "ses_child1", parentID: "ses_parent" }),
        get: async () => ({ id: "ses_parent", metadata: {} }),
        prompt: async () => {
          entered()
          await new Promise<void>(() => {})
        },
        wait: mock(async () => {}),
        switchModel: mock(async () => {}),
        interrupt,
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    const adapter = createExecutionAdapter(host, options)
    const result = adapter
      .launch(request(), { ...resolved(), background: true }, controller.signal)
      .catch((error) => error)
    await prompting
    controller.abort()
    expect(await result).toMatchObject({ code: "cancelled" })
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(host.session.wait).not.toHaveBeenCalled()
  }, 1000)

  test("abort durante create interrompe filha criada e não admite prompt background", async () => {
    const controller = new AbortController()
    const prompt = mock(async () => ({}))
    const interrupt = mock(async (_input: InterruptInput) => ({}))
    const host: HostPorts = {
      session: {
        create: async () => {
          controller.abort()
          return { id: "ses_child1" }
        },
        get: async () => ({ id: "ses_parent", metadata: {} }),
        prompt,
        wait: async () => {},
        switchModel: async () => {},
        interrupt,
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    const adapter = createExecutionAdapter(host, options)
    await expect(
      adapter.launch(request(), { ...resolved(), background: true }, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" })
    expect(prompt).not.toHaveBeenCalled()
    expect(interrupt.mock.calls).toEqual([[{ sessionID: "ses_child1" }]])
  })

  test("cancelamento de sessão não admitida não interrompe recursos do usuário", async () => {
    const interrupt = mock(async () => ({}))
    const adapter = createExecutionAdapter(
      {
        session: {
          create: async () => ({ id: "ses_unused" }),
          get: async () => parentRecord("ses_unused"),
          prompt: async () => ({}),
          wait: async () => {},
          switchModel: async () => {},
          interrupt,
        },
        agent: { get: async () => agentRecord() },
        skill: noSkills,
      },
      options,
    )
    await expect(adapter.cancel("ses_user")).rejects.toMatchObject({ code: "foreign-session" })
    expect(interrupt).not.toHaveBeenCalled()
  })

  test("interrompe a filha admitida pela suíte uma vez com chamadas concorrentes", async () => {
    const interrupt = mock(async (_input: InterruptInput) => ({}))
    const host: HostPorts = {
      session: {
        create: async () => ({ id: "ses_child1", parentID: "ses_parent" }),
        get: async () => ({ id: "ses_parent", metadata: {} }),
        prompt: async () => ({}),
        wait: async () => {},
        switchModel: async () => {},
        interrupt,
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    const adapter = createExecutionAdapter(host, options)
    await adapter.launch(
      request(),
      { ...resolved(), background: true },
      new AbortController().signal,
    )
    await Promise.all([adapter.cancel("ses_child1"), adapter.cancel("ses_child1")])
    await adapter.cancel("ses_child1")
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(interrupt.mock.calls[0]?.[0]).toEqual({ sessionID: "ses_child1" })
  })

  test("abort durante foreground interrompe filha e retorna erro cancelled", async () => {
    const controller = new AbortController()
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const interrupt = mock(async () => ({}))
    const host: HostPorts = {
      session: {
        create: async () => ({ id: "ses_child1", parentID: "ses_parent" }),
        get: async () => ({ id: "ses_parent", metadata: {} }),
        prompt: async () => ({}),
        wait: async () => {
          entered()
          await new Promise<void>(() => {})
        },
        switchModel: mock(async () => {}),
        interrupt,
      },
      agent: { get: async () => agentRecord() },
      skill: noSkills,
    }
    const adapter = createExecutionAdapter(host, options)
    const result = adapter.launch(request(), resolved(), controller.signal).catch((error) => error)
    await waiting
    controller.abort()
    expect(await result).toMatchObject({ code: "cancelled" })
    expect(interrupt).toHaveBeenCalledTimes(1)
  })
})
