import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { resolveOptions } from "../../src/config/resolve"
import { parseOptions } from "../../src/config/schema"
import { openRunJournal } from "../../src/execution/journal"
import { mountRuntime } from "../../src/runtime"

interface FixtureAgentRecord {
  id: string
  mode: string
  permissions: Array<{ action: string; resource: string; effect: string }>
  model?: { providerID: string; id: string }
}

interface FixturePrompt {
  sessionID: string
  skills?: Array<{ id: string; name: string }>
  [key: string]: unknown
}

interface FixtureSessionRecord {
  id: string
  projectID: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  outcome?: string
  prompt?: FixturePrompt
  [key: string]: unknown
}

interface FixtureToolRecord {
  name: string
  options: { permission: string }
  output?: unknown
}

interface FixtureNotification {
  id: string
  description: string
  text: string
  [key: string]: unknown
}

interface FixtureToolApi {
  namespace(): void
  get(id: string): FixtureToolRecord | undefined
  add(tool: FixtureToolRecord): void
}

interface FixtureContext {
  location: { directory: string; project: { id: string; canonical: string } }
  agent: {
    list(): Promise<{ data: Array<{ id: string; mode: string }> }>
    get(input: { agentID: string }): Promise<{ data: FixtureAgentRecord }>
  }
  model: { list(): Promise<{ data: Array<Record<string, unknown>> }> }
  skill: {
    list(): Promise<{ data: Array<{ id: string; name: string; description: string }> }>
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
  session: {
    get(input: { sessionID: string }): Promise<FixtureSessionRecord>
    create(input: Record<string, unknown>): Promise<FixtureSessionRecord>
    prompt(input: FixturePrompt): Promise<void>
    interrupt(input: { sessionID: string }): Promise<void>
    compact(input: { sessionID: string }): Promise<void>
    wait(): Promise<void>
    switchModel(): Promise<void>
    synthetic(input: FixtureNotification): Promise<void>
    hook(): Promise<{ dispose(): Promise<void> }>
  }
  tool: {
    transform(callback: (api: FixtureToolApi) => void): Promise<{ dispose(): Promise<void> }>
  }
  event: { subscribe(input: { signal: AbortSignal }): AsyncIterable<unknown> }
}

interface FixtureRuntimeStatus {
  scheduler: { active: number; queued: number }
  runs: Array<Record<string, unknown>>
}

function first<T>(items: readonly T[], what: string): T {
  const item = items[0]
  if (!item) throw new Error(`expected ${what}`)
  return item
}

test("intent persists without session and ambiguous admission cannot be retried", () => {
  const journal = openRunJournal(":memory:")
  journal.intent(
    "a",
    {
      projectID: "p",
      parentSessionID: "s",
      taskID: "t",
      route: { kind: "agent", id: "x" },
      prompt: "work",
      skills: [],
      background: true,
    },
    { agentID: "x", skills: [], prompt: "work", background: true },
  )
  expect(journal.unresolved()[0]?.phase).toBe("intent")
  expect(journal.retrySafe("s", "t")).toBe(false)
  journal.prepared("a", "child")
  expect(journal.unresolved()[0]?.sessionID).toBe("child")
  journal.terminal("a", "completed")
  expect(journal.unresolved()).toHaveLength(0)
  journal.close()
})

async function fixture(verifyArtifacts = false, overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "omo-runtime-"))
  const stateDir = await mkdtemp(join(tmpdir(), "omo-runtime-state-"))
  // Hermetic skills.sh seam: resolveTask auto-install coverage calls global
  // fetch (search + audits). Default to search-empty so no test ever performs
  // a live install (`npx skills add`); per-test overrides via setFetch.
  const realFetch = globalThis.fetch
  let fetchHandler: ((url: string) => Response) | undefined
  let fetchRestored = false
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (fetchHandler) return fetchHandler(url)
    if (url.includes("/api/search"))
      return new Response(JSON.stringify({ skills: [] }), { status: 200 })
    return new Response(JSON.stringify({ audits: [{ status: "fail" }] }), { status: 200 })
  }) as typeof fetch
  const restoreFetch = () => {
    if (!fetchRestored) {
      fetchRestored = true
      globalThis.fetch = realFetch
    }
  }
  const sessions = new Map<string, FixtureSessionRecord>([
    ["parent", { id: "parent", projectID: "p", agent: "leader" }],
  ])
  const mustSession = (sessionID: string): FixtureSessionRecord => {
    const session = sessions.get(sessionID)
    if (!session) throw new Error("unknown")
    return session
  }
  const tools = new Map<string, FixtureToolRecord>()
  const storage = new Map<string, unknown>()
  const notifications: FixtureNotification[] = []
  const compacted: string[] = []
  let next = 0
  let permission: "allow" | "deny" = "allow"
  const eventQueue: unknown[] = []
  const eventWaiters = new Set<() => void>()
  const emit = (event: unknown) => {
    eventQueue.push(event)
    for (const wake of [...eventWaiters]) wake()
  }
  const ctx: FixtureContext = {
    location: { directory, project: { id: "p", canonical: directory } },
    agent: {
      list: async () => ({ data: [{ id: "worker", mode: "subagent" }] }),
      get: async ({ agentID }: { agentID: string }) => ({
        data: {
          id: agentID,
          mode: "subagent",
          permissions: [{ action: "*", resource: "*", effect: permission }],
        },
      }),
    },
    model: { list: async () => ({ data: [] }) },
    skill: {
      list: async () => ({
        data: [
          { id: "skill-debug", name: "debug", description: "Debug runtime scheduler failures" },
        ],
      }),
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => mustSession(sessionID),
      create: async (input: Record<string, unknown>) => {
        const session: FixtureSessionRecord = { id: `child-${++next}`, projectID: "p" }
        Object.assign(session, input, { id: session.id, projectID: "p" })
        sessions.set(session.id, session)
        return session
      },
      prompt: async (input: FixturePrompt) => {
        const journal = openRunJournal(join(stateDir, "runs.sqlite"))
        expect(
          journal.unresolved().find((record) => record.sessionID === input.sessionID)?.phase,
        ).toBe("prepared")
        journal.close()
        mustSession(input.sessionID).prompt = input
      },
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        mustSession(sessionID).outcome = "interrupted"
      },
      compact: async ({ sessionID }: { sessionID: string }) => {
        if (!sessions.has(sessionID)) throw new Error("unknown")
        compacted.push(sessionID)
      },
      wait: async () => {},
      switchModel: async () => {},
      synthetic: async (input: FixtureNotification) => {
        if (!notifications.some((item) => item.id === input.id)) notifications.push(input)
      },
      hook: async () => ({ dispose: async () => {} }),
    },
    tool: {
      transform: async (callback: (api: FixtureToolApi) => void) => {
        callback({
          namespace() {},
          get: (id: string) => tools.get(id),
          add: (tool: FixtureToolRecord) => {
            tools.set(`omo_${tool.name}`, tool)
          },
        })
        return { dispose: async () => tools.clear() }
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (eventQueue.length > 0) yield eventQueue.shift()
            if (signal.aborted) return
            await new Promise<void>((resolve) => {
              const wake = () => {
                eventWaiters.delete(wake)
                signal.removeEventListener("abort", wake)
                resolve()
              }
              eventWaiters.add(wake)
              signal.addEventListener("abort", wake, { once: true })
            })
          }
        },
      }),
    },
  }
  const cleanup = await mountRuntime(
    ctx as unknown as Plugin.Context,
    stateDir,
    resolveOptions(
      parseOptions({
        schemaVersion: 1,
        ...overrides,
        execution: { verifyArtifacts, ...((overrides.execution as object) ?? {}) },
      }),
    ),
  )
  const wrappedCleanup = (async () => {
    try {
      await cleanup()
    } finally {
      restoreFetch()
    }
  }) as typeof cleanup
  wrappedCleanup.services = cleanup.services
  wrappedCleanup.repository = cleanup.repository
  wrappedCleanup.scopeFor = cleanup.scopeFor
  return {
    cleanup: wrappedCleanup,
    ctx,
    sessions,
    session: (id: string) => mustSession(id),
    tools,
    tool: (id: string) => {
      const record = tools.get(id)
      if (!record) throw new Error(`unknown tool ${id}`)
      return record
    },
    notifications,
    compacted,
    directory,
    stateDir,
    emit,
    setFetch: (handler: (url: string) => Response) => {
      fetchHandler = handler
    },
    deny: () => {
      permission = "deny"
    },
    remove: () =>
      Promise.all([
        rm(directory, { recursive: true, force: true }),
        rm(stateDir, { recursive: true, force: true }),
      ]),
  }
}
test("simultaneous child completions do not flood the parent with identical result blocks", async () => {
  const f = await fixture()
  try {
    const handles = await Promise.all(
      ["one", "two", "three"].map((taskID) =>
        f.cleanup.services.delegate(
          "parent",
          { taskID, route: { kind: "agent", id: "worker" }, prompt: "inspect", files: [] },
          new AbortController().signal,
        ),
      ),
    )
    for (const handle of handles) f.session(handle.sessionID).outcome = "succeeded"
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(f.notifications).toHaveLength(1)
    const firstNotice = first(f.notifications, "notification")
    expect(firstNotice.description).toBe("OmO: 3 child results")
    for (const task of ["one", "two", "three"])
      expect(firstNotice.text).toContain(`task ${task}: completed`)
  } finally {
    await f.cleanup()
    await f.remove()
  }
})

test.each(["provider", "model", "agent"])(
  "host default and explicit model share the %s concurrency cap",
  async (limit) => {
    const f = await fixture(false, {
      execution:
        limit !== "model"
          ? { providerLimits: { openai: 1 } }
          : { modelLimits: { "openai/shared": 1 } },
    })
    try {
      f.ctx.model.list = async () => ({ data: [{ providerID: "openai", id: "shared" }] })
      f.session("parent").model = { providerID: "openai", id: "shared" }
      if (limit === "agent") {
        f.session("parent").model = { providerID: "other", id: "unavailable" }
        const get = f.ctx.agent.get
        f.ctx.agent.get = async (input: { agentID: string }) => ({
          data: { ...(await get(input)).data, model: { providerID: "openai", id: "shared" } },
        })
      }
      const signal = new AbortController().signal
      const first = await f.cleanup.services.delegate(
        "parent",
        {
          taskID: "default",
          route: { kind: "agent", id: "worker" },
          prompt: "work",
          files: ["a.ts"],
        },
        signal,
      )
      expect(f.session(first.sessionID).model).toEqual({ providerID: "openai", id: "shared" })
      const second = f.cleanup.services.delegate(
        "parent",
        {
          taskID: "explicit",
          route: { kind: "agent", id: "worker" },
          prompt: "work",
          files: ["b.ts"],
          explicitModel: { providerID: "openai", modelID: "shared" },
        },
        signal,
      )
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          ((await f.cleanup.services.status("parent")) as FixtureRuntimeStatus).scheduler.queued ===
          1
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(
        ((await f.cleanup.services.status("parent")) as FixtureRuntimeStatus).scheduler,
      ).toEqual({
        active: 1,
        queued: 1,
      })
      expect(f.sessions.size).toBe(2)
      f.session(first.sessionID).outcome = "succeeded"
      const handle = await second
      expect(f.sessions.size).toBe(3)
      expect(f.session(handle.sessionID).model).toEqual({ providerID: "openai", id: "shared" })
    } finally {
      await f.cleanup()
      await f.remove()
    }
  },
)
test.each(["explicit", "category", "profile"])(
  "configured %s model takes precedence over host default under limits",
  async (source) => {
    const model = { providerID: "openai", modelID: "shared" }
    const f = await fixture(false, {
      execution: { providerLimits: { openai: 1 } },
      ...(source === "profile" ? { profiles: [{ id: "worker", model }] } : {}),
      ...(source === "category"
        ? {
            profiles: [{ id: "worker" }],
            categories: [{ id: "implement", agent: "worker", model }],
          }
        : {}),
    })
    try {
      f.ctx.model.list = async () => ({ data: [{ providerID: "openai", id: "shared" }] })
      const get = f.ctx.agent.get
      f.ctx.agent.get = async (input: { agentID: string }) => ({
        data: { ...(await get(input)).data, model: { providerID: "other", id: "unavailable" } },
      })
      const handle = await f.cleanup.services.delegate(
        "parent",
        {
          taskID: source,
          route:
            source === "category"
              ? { kind: "category", id: "implement" }
              : { kind: "agent", id: "worker" },
          prompt: "work",
          ...(source === "explicit" ? { explicitModel: model } : {}),
        },
        new AbortController().signal,
      )
      expect(f.session(handle.sessionID).model).toEqual({ providerID: "openai", id: "shared" })
    } finally {
      await f.cleanup()
      await f.remove()
    }
  },
)
test.each(["missing", "unavailable", "disallowed", "global", "variant"])(
  "limited host default fails closed before admission: %s",
  async (reason) => {
    const f = await fixture(false, {
      execution: { providerLimits: { openai: 1 } },
      ...(reason === "disallowed"
        ? {
            profiles: [
              {
                id: "worker",
                allowedModels: [{ providerID: "openai", modelID: "shared", variant: "other" }],
              },
            ],
          }
        : {}),
      ...(reason === "global"
        ? { allowedModels: [{ providerID: "openai", modelID: "shared", variant: "other" }] }
        : {}),
    })
    try {
      f.ctx.model.list = async () => ({
        data:
          reason === "unavailable"
            ? []
            : [{ providerID: "openai", id: "shared", variants: { other: {} } }],
      })
      if (reason !== "missing")
        f.session("parent").model = {
          providerID: "openai",
          id: "shared",
          ...(reason === "variant" ? { variant: "absent" } : {}),
        }
      await expect(
        f.cleanup.services.delegate(
          "parent",
          {
            taskID: "denied-default",
            route: { kind: "agent", id: "worker" },
            prompt: "work",
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        reason === "missing"
          ? "explicitModel"
          : reason === "disallowed" || reason === "global"
            ? "not permitted"
            : "unavailable",
      )
      expect(f.sessions.size).toBe(1)
      const status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
      expect(status.runs).toHaveLength(0)
      expect(status.scheduler).toEqual({ active: 0, queued: 0 })
    } finally {
      await f.cleanup()
      await f.remove()
    }
  },
)
test.each([false, true])("runtime artifact verification opt-in: %s", async (enabled) => {
  const f = await fixture(enabled)
  try {
    await f.cleanup.services.create("parent", "artifacts", [
      { id: "step", objective: "work", dependencies: [] },
    ])
    const handle = await f.cleanup.services.delegate(
      "parent",
      {
        taskID: "artifact-task",
        planID: "artifacts",
        stepID: "step",
        route: { kind: "agent", id: "worker" },
        prompt: "work",
      },
      new AbortController().signal,
    )
    f.session(handle.sessionID).outcome = "succeeded"
    await new Promise((resolve) => setTimeout(resolve, 130))
    const evidence = [
      {
        id: "file",
        description: "generated report",
        artifact: "missing-report.md",
        command: "bun test test/integration",
        exitCode: 0,
        revision: "abc123",
        artifactHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        origin: "auto" as const,
      },
    ]
    if (enabled) {
      await expect(
        f.cleanup.services.verify("parent", "artifacts", "step", evidence),
      ).rejects.toThrow("missing")
      await expect(
        f.cleanup.services.verify("parent", "artifacts", "step", [
          { ...first(evidence, "evidence"), artifact: "../outside.md" },
        ]),
      ).rejects.toThrow("outside project root")
    } else {
      expect(
        (await f.cleanup.services.verify("parent", "artifacts", "step", evidence)).steps[0]?.state,
      ).toBe("completed")
    }
  } finally {
    await f.cleanup()
    await f.remove()
  }
})
test("public tools preserve subagent gate, durable prompt admission, verification and exactly one notification", async () => {
  const f = await fixture()
  try {
    expect(f.tool("omo_delegate").options.permission).toBe("subagent")
    expect(f.tool("omo_parallel").options.permission).toBe("subagent")
    await f.cleanup.services.create("parent", "plan", [
      { id: "step", objective: "work", dependencies: [] },
    ])
    const handle = await f.cleanup.services.delegate(
      "parent",
      {
        taskID: "t",
        route: { kind: "agent", id: "worker" },
        prompt: "Debug runtime scheduler failures",
        planID: "plan",
        stepID: "step",
      },
      new AbortController().signal,
    )
    expect(f.session(handle.sessionID).prompt?.skills).toEqual([
      { id: "skill-debug", name: "debug" },
    ])
    const status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
    const run = status.runs[0]
    if (!run) throw new Error("expected run status")
    expect(run).toMatchObject({
      skills: ["skill-debug"],
      skillReasons: [{ id: "skill-debug", source: "recommended" }],
      depth: 1,
      effectiveModel: null,
    })
    expect(run.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(status.runs)).not.toContain("Debug runtime scheduler failures")
    await expect(f.cleanup.services.verify("parent", "plan", "step", [])).rejects.toThrow("finish")
    f.session(handle.sessionID).outcome = "succeeded"
    await new Promise((resolve) => setTimeout(resolve, 130))
    await expect(f.cleanup.services.verify("parent", "plan", "step", [])).rejects.toThrow(
      "evidence",
    )
    const plan = await f.cleanup.services.verify("parent", "plan", "step", [
      {
        id: "test",
        description: "Fixture assertion passed",
        command: "bun test test/integration",
        exitCode: 0,
        revision: "abc123",
        origin: "auto",
      },
    ])
    expect(plan.steps[0]?.state).toBe("completed")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(f.notifications).toHaveLength(1)
    expect(first(f.notifications, "notification").id).toMatch(/^msg_/)
    for (const tool of f.tools.values()) expect(tool.output).toBeDefined()
    await f.cleanup.services.status("parent")
    expect(f.notifications).toHaveLength(1)
    f.deny()
    await expect(
      f.cleanup.services.delegate(
        "parent",
        { taskID: "deny", route: { kind: "agent", id: "worker" }, prompt: "work" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("deny")
    expect(f.sessions.size).toBe(2)
  } finally {
    await f.cleanup()
    await f.cleanup()
    await f.remove()
  }
})
test("parallel admissions overlap and unload detaches every owned child for recovery", async () => {
  const f = await fixture()
  try {
    const handles = await f.cleanup.services.batch(
      "parent",
      ["a", "b", "c"].map((taskID) => ({
        taskID,
        prompt: "independent query",
        files: [`${taskID}.ts`],
        route: { kind: "agent" as const, id: "worker" },
      })),
      new AbortController().signal,
    )
    expect(handles).toHaveLength(3)
    await f.cleanup()
    // Unload stops observation without interrupting native children, so the
    // next runtime instance can reconcile and adopt them (ADR-0013).
    for (const handle of handles) expect(f.session(handle.sessionID).outcome).toBeUndefined()
    expect(f.tools.size).toBe(0)
  } finally {
    await f.cleanup()
    await f.remove()
  }
})
test("native compact reconciles durable state and refuses foreign sessions", async () => {
  const f = await fixture()
  try {
    await f.cleanup.services.create("parent", "plan", [
      { id: "step", objective: "work", dependencies: [] },
    ])
    const report = await f.cleanup.services.compact("parent")
    expect(f.compacted).toEqual(["parent"])
    expect(JSON.stringify(report)).toContain("step")
    await expect(f.cleanup.services.compact("parent", "elsewhere")).rejects.toThrow(
      "foreign-session",
    )
    expect(f.compacted).toEqual(["parent"])
    const handle = await f.cleanup.services.delegate(
      "parent",
      { taskID: "t", route: { kind: "agent" as const, id: "worker" }, prompt: "work" },
      new AbortController().signal,
    )
    const childReport = await f.cleanup.services.compact("parent", handle.sessionID)
    expect(f.compacted).toContain(handle.sessionID)
    expect(JSON.stringify(childReport)).toContain("step")
  } finally {
    await f.cleanup()
    await f.remove()
  }
})
test("background delegation survives tool signal interruption and completes normally", async () => {
  const f = await fixture()
  try {
    const tool = new AbortController()
    const handle = await f.cleanup.services.delegate(
      "parent",
      {
        taskID: "bg-tool",
        route: { kind: "agent", id: "worker" },
        prompt: "work",
        files: ["a.ts"],
      },
      tool.signal,
    )
    expect(f.session(handle.sessionID).outcome).toBeUndefined()
    tool.abort(new Error("parent step interrupted"))
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(f.session(handle.sessionID).outcome).toBeUndefined()
    f.session(handle.sessionID).outcome = "succeeded"
    let status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
    let run = status.runs.find((item) => item.sessionID === handle.sessionID)
    for (let attempt = 0; attempt < 100 && run?.phase !== "completed"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
      run = status.runs.find((item) => item.sessionID === handle.sessionID)
    }
    expect(run?.phase).toBe("completed")
    for (let attempt = 0; attempt < 100 && f.notifications.length === 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    expect(f.notifications).toHaveLength(1)
    expect(first(f.notifications, "notification").text).toContain("completed")
  } finally {
    await f.cleanup()
    await f.remove()
  }
})
test("parent interruption cancels foreground children but leaves background children running", async () => {
  const f = await fixture()
  try {
    const bg = await f.cleanup.services.delegate(
      "parent",
      { taskID: "bg", route: { kind: "agent", id: "worker" }, prompt: "work", files: ["a.ts"] },
      new AbortController().signal,
    )
    const fgRun = f.cleanup.services.delegate(
      "parent",
      {
        taskID: "fg",
        route: { kind: "agent", id: "worker" },
        prompt: "work",
        files: ["b.ts"],
        background: false,
      },
      new AbortController().signal,
    )
    void fgRun.catch(() => {})
    for (let attempt = 0; attempt < 100 && f.sessions.size < 3; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 25))
    const fgSessionID = [...f.sessions.keys()].find((id) => id !== "parent" && id !== bg.sessionID)
    if (!fgSessionID) throw new Error("expected foreground child session")
    f.emit({ type: "session.execution.interrupted", data: { sessionID: "parent" } })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(f.session(fgSessionID).outcome).toBe("interrupted")
    expect(f.session(bg.sessionID).outcome).toBeUndefined()
    f.session(bg.sessionID).outcome = "succeeded"
    let status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
    let run = status.runs.find((item) => item.sessionID === bg.sessionID)
    for (let attempt = 0; attempt < 100 && run?.phase !== "completed"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
      run = status.runs.find((item) => item.sessionID === bg.sessionID)
    }
    expect(run?.phase).toBe("completed")
    for (let attempt = 0; attempt < 100 && f.notifications.length === 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    expect(f.notifications).toHaveLength(1)
    expect(first(f.notifications, "notification").text).toContain("completed")
  } finally {
    await f.cleanup()
    await f.remove()
  }
})
test(
  "runtime unload detaches running background children for later recovery",
  async () => {
    const f = await fixture()
    try {
      const handle = await f.cleanup.services.delegate(
        "parent",
        {
          taskID: "bg-unload",
          route: { kind: "agent", id: "worker" },
          prompt: "work",
          files: ["a.ts"],
        },
        new AbortController().signal,
      )
      await f.cleanup()
      expect(f.session(handle.sessionID).outcome).toBeUndefined()
      const journal = openRunJournal(join(f.stateDir, "runs.sqlite"))
      const record = journal.unresolved().find((item) => item.sessionID === handle.sessionID)
      expect(record?.phase).toBe("admitted")
      journal.close()
    } finally {
      await f.cleanup()
      await f.remove()
    }
  },
  { timeout: 30000 },
)

test(
  "auto-install disabled leaves skills empty and status carries empty installedSkills",
  async () => {
    const f = await fixture(false, { skills: { autoInstall: false } })
    try {
      const handle = await f.cleanup.services.delegate(
        "parent",
        {
          taskID: "no-cover",
          route: { kind: "agent", id: "worker" },
          prompt: "entirely unrelated xyzzy prompt with no token overlap",
        },
        new AbortController().signal,
      )
      expect(f.session(handle.sessionID).prompt?.skills).toBeUndefined()
      const status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
      const run = status.runs.find((item) => item.sessionID === handle.sessionID)
      expect(run?.skills).toEqual([])
      expect(run?.installedSkills).toEqual([])
    } finally {
      await f.cleanup()
      await f.remove()
    }
  },
  { timeout: 30000 },
)

test("search-empty surfaces in installedSkills and status without touching host skills", async () => {
  const f = await fixture()
  try {
    const prompt = "entirely unrelated xyzzy prompt with no token overlap"
    const handle = await f.cleanup.services.delegate(
      "parent",
      { taskID: "search-empty", route: { kind: "agent", id: "worker" }, prompt },
      new AbortController().signal,
    )
    expect(f.session(handle.sessionID).prompt?.skills).toBeUndefined()
    const status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
    const run = status.runs.find((item) => item.sessionID === handle.sessionID)
    expect(run?.skills).toEqual([])
    expect(run?.installedSkills).toEqual([
      { id: prompt, source: "skills.sh", outcome: "search-empty" },
    ])
  } finally {
    await f.cleanup()
    await f.remove()
  }
})

test("refused-audit excludes the fresh skill from the host prompt but records it in status", async () => {
  const f = await fixture()
  try {
    f.setFetch((url) =>
      url.includes("/api/search")
        ? new Response(
            JSON.stringify({
              skills: [
                {
                  id: "obra/superpowers/tdd",
                  source: "obra/superpowers",
                  skillId: "tdd",
                  name: "tdd",
                },
              ],
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ audits: [{ status: "fail" }] }), { status: 200 }),
    )
    const handle = await f.cleanup.services.delegate(
      "parent",
      {
        taskID: "refused",
        route: { kind: "agent", id: "worker" },
        prompt: "entirely unrelated xyzzy prompt with no token overlap",
      },
      new AbortController().signal,
    )
    // Freshly installed skills are excluded from the host prompt this run:
    // the host revalidates against its own catalog and throws unknown-skill.
    expect(f.session(handle.sessionID).prompt?.skills).toBeUndefined()
    const status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
    const run = status.runs.find((item) => item.sessionID === handle.sessionID)
    expect(run?.skills).toEqual([])
    expect(run?.installedSkills).toEqual([
      { id: "tdd", source: "obra/superpowers", outcome: "refused-audit" },
    ])
  } finally {
    await f.cleanup()
    await f.remove()
  }
})

test("filesystem-only skill resolves from the merged catalog yet filters out of the host prompt", async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.directory, ".agents", "skills", "fs-only"), { recursive: true })
    await writeFile(
      join(f.directory, ".agents", "skills", "fs-only", "SKILL.md"),
      "---\nname: Zephyr Quux\ndescription: Zephyr quux filesystem supplement\n---\n# fs-only\n",
    )
    let fetched = 0
    f.setFetch(() => {
      fetched++
      return new Response(JSON.stringify({ skills: [] }), { status: 200 })
    })
    const handle = await f.cleanup.services.delegate(
      "parent",
      {
        taskID: "fs-filter",
        route: { kind: "agent", id: "worker" },
        prompt: "Zephyr quux filesystem work",
      },
      new AbortController().signal,
    )
    // Merged catalog already covers the prompt, so no search runs at all.
    expect(fetched).toBe(0)
    expect(f.session(handle.sessionID).prompt?.skills).toBeUndefined()
    const status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
    const run = status.runs.find((item) => item.sessionID === handle.sessionID)
    expect(run?.skills).toEqual([])
    expect(run?.installedSkills).toEqual([])
  } finally {
    await f.cleanup()
    await f.remove()
  }
})

// --- Recovery capacity accounting (ADR-0016) ---------------------------------
// A blocked/intent/unknown record owns no observable native work: it must not
// consume a scheduler slot, otherwise every later delegation queues forever
// and the calling omo tool spins with no progress.

function seedJournal(stateDir: string, seed: (journal: ReturnType<typeof openRunJournal>) => void) {
  const journal = openRunJournal(join(stateDir, "runs.sqlite"))
  try {
    seed(journal)
  } finally {
    journal.close()
  }
}

function delegation(taskID: string) {
  return {
    projectID: "p",
    parentSessionID: "parent",
    taskID,
    route: { kind: "agent" as const, id: "worker" },
    prompt: "work",
    skills: [],
    background: true,
  }
}

const delegationResolved = { agentID: "worker", skills: [], prompt: "work", background: true }

async function remountRuntime(
  f: Awaited<ReturnType<typeof fixture>>,
  execution: Record<string, unknown> = {},
) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ skills: [] }), { status: 200 })) as unknown as typeof fetch
  try {
    const mounted = await mountRuntime(
      f.ctx as unknown as Plugin.Context,
      f.stateDir,
      resolveOptions(
        parseOptions({
          schemaVersion: 1,
          execution: { admissionTimeoutMs: 2000, ...execution },
          skills: { autoInstall: false },
        }),
      ),
    )
    return mounted
  } finally {
    globalThis.fetch = realFetch
  }
}

test("recovery never reserves capacity for blocked, intent or unknown records", async () => {
  const f = await fixture()
  let remount: Awaited<ReturnType<typeof mountRuntime>> | undefined
  try {
    await f.cleanup()
    seedJournal(f.stateDir, (journal) => {
      journal.intent("attempt-intent", delegation("intent-task"), delegationResolved)
      journal.intent("attempt-ghost", delegation("ghost-task"), delegationResolved)
      journal.prepared("attempt-ghost", "missing-session")
      journal.admitted("attempt-ghost")
      journal.intent("attempt-blocked", delegation("blocked-task"), delegationResolved)
      journal.block("attempt-blocked", "previously blocked")
    })
    remount = await remountRuntime(f)
    // All three leaked-slot shapes from the wild are pinned but unreserved:
    // a fresh delegation is admitted immediately instead of queueing forever.
    const handle = await remount.services.delegate(
      "parent",
      { taskID: "fresh", route: { kind: "agent" as const, id: "worker" }, prompt: "work" },
      new AbortController().signal,
    )
    expect(f.session(handle.sessionID).prompt).toBeDefined()
    const status = (await remount.services.status("parent")) as FixtureRuntimeStatus
    expect(status.scheduler.active).toBe(1)
    await expect(
      remount.services.delegate(
        "parent",
        { taskID: "intent-task", route: { kind: "agent" as const, id: "worker" }, prompt: "work" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("unreconciled-attempt")
  } finally {
    await remount?.()
    await f.cleanup()
    await f.remove()
  }
})

test("recovery reaps a stale admitted zombie and frees its capacity", async () => {
  const f = await fixture()
  let remount: Awaited<ReturnType<typeof mountRuntime>> | undefined
  try {
    await f.cleanup()
    f.sessions.set("zombie-child", {
      id: "zombie-child",
      projectID: "p",
      parentID: "parent",
      time: { updated: Date.now() - 3 * 60 * 60 * 1000 },
    })
    seedJournal(f.stateDir, (journal) => {
      journal.intent("attempt-zombie", delegation("zombie-task"), delegationResolved)
      journal.prepared("attempt-zombie", "zombie-child")
      journal.admitted("attempt-zombie")
    })
    remount = await remountRuntime(f, { staleTimeoutMs: 100 })
    let status = (await remount.services.status("parent")) as FixtureRuntimeStatus
    let run = status.runs.find((item) => item.taskID === "zombie-task")
    for (let attempt = 0; attempt < 100 && run?.phase !== "cancelled"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      status = (await remount.services.status("parent")) as FixtureRuntimeStatus
      run = status.runs.find((item) => item.taskID === "zombie-task")
    }
    expect(run?.phase).toBe("cancelled")
    expect(f.session("zombie-child").outcome).toBe("interrupted")
    expect(status.scheduler.active).toBe(0)
    // The terminal taskID is reusable: delegation with it succeeds.
    const handle = await remount.services.delegate(
      "parent",
      { taskID: "zombie-task", route: { kind: "agent" as const, id: "worker" }, prompt: "work" },
      new AbortController().signal,
    )
    expect(f.session(handle.sessionID).prompt).toBeDefined()
  } finally {
    await remount?.()
    await f.cleanup()
    await f.remove()
  }
})

test("recovery supervises a running prepared child instead of blocking it", async () => {
  const f = await fixture()
  let remount: Awaited<ReturnType<typeof mountRuntime>> | undefined
  try {
    await f.cleanup()
    f.sessions.set("prepared-child", {
      id: "prepared-child",
      projectID: "p",
      parentID: "parent",
      time: { updated: Date.now() },
    })
    seedJournal(f.stateDir, (journal) => {
      journal.intent("attempt-prepared", delegation("prepared-task"), delegationResolved)
      journal.prepared("attempt-prepared", "prepared-child")
    })
    remount = await remountRuntime(f)
    f.session("prepared-child").outcome = "succeeded"
    let status = (await remount.services.status("parent")) as FixtureRuntimeStatus
    let run = status.runs.find((item) => item.taskID === "prepared-task")
    for (let attempt = 0; attempt < 100 && run?.phase !== "completed"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      status = (await remount.services.status("parent")) as FixtureRuntimeStatus
      run = status.runs.find((item) => item.taskID === "prepared-task")
    }
    expect(run?.phase).toBe("completed")
    expect(status.scheduler.active).toBe(0)
  } finally {
    await remount?.()
    await f.cleanup()
    await f.remove()
  }
})

test("cancel frees pinned taskIDs by terminalizing every unresolved record", async () => {
  const f = await fixture()
  try {
    seedJournal(f.stateDir, (journal) => {
      journal.intent("attempt-intent", delegation("pinned-intent"), delegationResolved)
      journal.intent("attempt-ghost", delegation("pinned-ghost"), delegationResolved)
      journal.prepared("attempt-ghost", "missing-session")
      journal.intent("attempt-blocked", delegation("pinned-blocked"), delegationResolved)
      journal.block("attempt-blocked", "previously blocked")
    })
    await f.cleanup.services.cancel("parent")
    const status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
    const phases = new Map(status.runs.map((item) => [item.taskID, item.phase]))
    expect(phases.get("pinned-intent")).toBe("cancelled")
    expect(phases.get("pinned-ghost")).toBe("cancelled")
    expect(phases.get("pinned-blocked")).toBe("cancelled")
    expect(status.scheduler.active).toBe(0)
    // Freed taskIDs accept new delegations.
    const handle = await f.cleanup.services.delegate(
      "parent",
      {
        taskID: "pinned-blocked",
        route: { kind: "agent" as const, id: "worker" },
        prompt: "work",
      },
      new AbortController().signal,
    )
    expect(f.session(handle.sessionID).prompt).toBeDefined()
  } finally {
    await f.cleanup()
    await f.remove()
  }
})

test("a saturated runtime rejects new delegations once the admission budget expires", async () => {
  const f = await fixture(false, {
    execution: { maxChildren: 1, admissionTimeoutMs: 150 },
  })
  try {
    await f.cleanup.services.delegate(
      "parent",
      { taskID: "hold", route: { kind: "agent" as const, id: "worker" }, prompt: "work" },
      new AbortController().signal,
    )
    await expect(
      f.cleanup.services.delegate(
        "parent",
        { taskID: "queued", route: { kind: "agent" as const, id: "worker" }, prompt: "work" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("admission-timeout")
    const status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
    expect(status.scheduler).toEqual({ active: 1, queued: 0 })
  } finally {
    await f.cleanup()
    await f.remove()
  }
})

test("a live background child that stops updating is reaped by the stale bound", async () => {
  const f = await fixture(false, { execution: { staleTimeoutMs: 150 } })
  try {
    const handle = await f.cleanup.services.delegate(
      "parent",
      { taskID: "stale-live", route: { kind: "agent" as const, id: "worker" }, prompt: "work" },
      new AbortController().signal,
    )
    f.session(handle.sessionID).time = { updated: Date.now() - 60 * 60 * 1000 }
    let status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
    let run = status.runs.find((item) => item.sessionID === handle.sessionID)
    // The reap terminalizes the record first; the scheduler releases the live
    // entry a few microtasks later, so wait for the slot before asserting.
    for (
      let attempt = 0;
      attempt < 100 && (run?.phase !== "cancelled" || status.scheduler.active !== 0);
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      status = (await f.cleanup.services.status("parent")) as FixtureRuntimeStatus
      run = status.runs.find((item) => item.sessionID === handle.sessionID)
    }
    expect(run?.phase).toBe("cancelled")
    expect(f.session(handle.sessionID).outcome).toBe("interrupted")
    expect(status.scheduler.active).toBe(0)
  } finally {
    await f.cleanup()
    await f.remove()
  }
})
