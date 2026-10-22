import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { mountTeams } from "../../src/teams/tools"

interface TeamToolResult {
  content: string
  output?: unknown
}

interface TeamToolHandle {
  execute: (
    args: Record<string, unknown>,
    context: { sessionID: string },
  ) => Promise<TeamToolResult>
}

interface TeamToolsSessionRecord {
  id: string
  projectID: string
  parentID?: string
  agent?: string
}

interface TeamToolsContext {
  location: { directory: string; project: { id: string; canonical: string } }
  session: {
    get: (input: { sessionID: string }) => Promise<TeamToolsSessionRecord>
  }
  tool: {
    transform: (
      callback: (api: { get(): void; add(value: TeamToolHandle): void }) => void,
    ) => Promise<{ dispose: () => Promise<void> }>
  }
}

test("a disposed mount reopens the team store instead of failing on a closed database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omo team tools "))
  const stateDir = await mkdtemp(join(tmpdir(), "omo team state "))
  let tool: TeamToolHandle | undefined
  const ctx: TeamToolsContext = {
    location: { directory, project: { id: "p", canonical: directory } },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, projectID: "p" }),
    },
    tool: {
      transform: async (callback) => {
        callback({
          get() {},
          add(value) {
            tool = value
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  const cleanup = await mountTeams(ctx as unknown as Plugin.Context, stateDir, { runtime: false })
  const handle = (): TeamToolHandle => {
    if (!tool) throw new Error("team tool was not registered")
    return tool
  }
  const call = (sessionID: string, input: Record<string, unknown>) =>
    handle().execute({ teamID: "t", ...input }, { sessionID })
  try {
    const created = await call("leader", { action: "create", members: ["leader"], tasks: [] })
    expect(typeof created.content).toBe("string")
    expect(created.output).toBeDefined()
    // The managed host keeps a continued session's mount callable after a run
    // ends, so a post-dispose tool call must reopen the store rather than hit
    // the closed handle cached during dispose.
    await cleanup()
    const after = await call("leader", { action: "status" })
    expect(after.content).toContain('"t"')
  } finally {
    // The reopened store keeps its SQLite handle open, so Windows can refuse
    // the removal until the handle is released; retry a few times before
    // leaving the temp directory behind.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(directory, { recursive: true, force: true })
        await rm(stateDir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  }
})

test("native team tool awaits durable claims and uses the caller as mailbox identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omo team tools "))
  const stateDir = await mkdtemp(join(tmpdir(), "omo team state "))
  let tool: TeamToolHandle | undefined
  const ctx: TeamToolsContext = {
    location: { directory, project: { id: "p", canonical: directory } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        projectID: "p",
        ...(sessionID === "leader" ? {} : { parentID: "leader" }),
      }),
    },
    tool: {
      transform: async (
        callback: (api: { get(): void; add(value: TeamToolHandle): void }) => void,
      ) => {
        callback({
          get() {},
          add(value: TeamToolHandle) {
            tool = value
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  const cleanup = await mountTeams(ctx as unknown as Plugin.Context, stateDir, { runtime: false })
  const handle = (): TeamToolHandle => {
    if (!tool) {
      throw new Error("team tool was not registered")
    }
    return tool
  }
  const call = (sessionID: string, input: Record<string, unknown>) =>
    handle().execute({ teamID: "t", ...input }, { sessionID })
  try {
    const created = await call("leader", {
      action: "create",
      members: ["leader", "child"],
      tasks: [{ id: "work", dependencies: [] }],
    })
    expect(JSON.parse(created.content).id).toBe("t")
    const claimed = await call("child", { action: "claim", taskID: "work" })
    expect(JSON.parse(claimed.content).memberID).toBe("child")
    const sent = await call("leader", {
      action: "send",
      recipientID: "child",
      dedupKey: "hello",
      body: "Review the evidence",
    })
    const messages = await call("child", { action: "read" })
    expect(JSON.parse(messages.content)[0].id).toBe(sent.output)
    await call("child", { action: "ack", messageID: sent.output })
    expect(JSON.parse((await call("child", { action: "read" })).content)).toEqual([])
    await expect(call("outsider", { action: "status" })).rejects.toThrow("member-inactive")
  } finally {
    await cleanup()
    await rm(directory, { recursive: true, force: true })
    await rm(stateDir, { recursive: true, force: true })
  }
})

test("team tool lists teams and performs task CRUD with leader authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omo team task crud "))
  const stateDir = await mkdtemp(join(tmpdir(), "omo team state "))
  let tool: TeamToolHandle | undefined
  const ctx: TeamToolsContext = {
    location: { directory, project: { id: "p", canonical: directory } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        projectID: "p",
        ...(sessionID === "leader" ? {} : { parentID: "leader" }),
      }),
    },
    tool: {
      transform: async (
        callback: (api: { get(): void; add(value: TeamToolHandle): void }) => void,
      ) => {
        callback({
          get() {},
          add(value: TeamToolHandle) {
            tool = value
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  const cleanup = await mountTeams(ctx as unknown as Plugin.Context, stateDir, { runtime: false })
  const handle = (): TeamToolHandle => {
    if (!tool) {
      throw new Error("team tool was not registered")
    }
    return tool
  }
  const call = (sessionID: string, input: Record<string, unknown>) =>
    handle().execute({ teamID: "t", ...input }, { sessionID })
  const bare = (sessionID: string, input: Record<string, unknown>) =>
    handle().execute(input, { sessionID })
  try {
    await call("leader", {
      action: "create",
      members: ["leader", "child"],
      tasks: [{ id: "work", dependencies: [] }],
    })
    await expect(
      call("child", { action: "task_create", taskID: "followup", dependencies: ["work"] }),
    ).rejects.toThrow("leader-required")
    const created = await call("leader", {
      action: "task_create",
      taskID: "followup",
      dependencies: ["work"],
    })
    expect(
      (JSON.parse(created.content) as { tasks: Array<{ id: string }> }).tasks.map(
        (task) => task.id,
      ),
    ).toContain("followup")
    const listed = await call("child", { action: "task_list" })
    expect(
      (JSON.parse(listed.content) as Array<{ id: string }>).map((task) => task.id).sort(),
    ).toEqual(["followup", "work"])
    const fetched = await call("child", { action: "task_get", taskID: "followup" })
    expect((JSON.parse(fetched.content) as { dependencies: string[] }).dependencies).toEqual([
      "work",
    ])
    const updated = await call("leader", {
      action: "task_update",
      taskID: "followup",
      dependencies: [],
    })
    expect(
      (
        JSON.parse(updated.content) as { tasks: Array<{ id: string; dependencies: string[] }> }
      ).tasks.find((task) => task.id === "followup")?.dependencies,
    ).toEqual([])
    await expect(call("outsider", { action: "task_list" })).rejects.toThrow("member-inactive")
    // `list` must work without teamID: leader sees every scoped team, a member
    // sees only teams where it is active, an outsider sees none.
    const leaderList = await bare("leader", { action: "list" })
    expect(
      (JSON.parse(leaderList.content) as Array<{ id: string }>).map((team) => team.id),
    ).toEqual(["t"])
    const childList = await bare("child", { action: "list" })
    expect((JSON.parse(childList.content) as Array<{ id: string }>).map((team) => team.id)).toEqual(
      ["t"],
    )
    const outsiderList = await bare("outsider", { action: "list" })
    expect(JSON.parse(outsiderList.content)).toEqual([])
  } finally {
    await cleanup()
    await rm(directory, { recursive: true, force: true })
    await rm(stateDir, { recursive: true, force: true })
  }
})

test("native team registration retains the documented task permission for mailbox coordination", async () => {
  const registrations: Array<{
    name: string
    options?: { namespace?: string; permission?: string }
  }> = []
  const ctx = {
    tool: {
      transform: async (
        callback: (editor: {
          get(): undefined
          add(value: (typeof registrations)[number]): void
        }) => void,
      ) => {
        callback({ get: () => undefined, add: (value) => registrations.push(value) })
        return { dispose: async () => {} }
      },
    },
  }
  const stateDir = await mkdtemp(join(tmpdir(), "omo team state "))
  const cleanup = await mountTeams(ctx as unknown as Plugin.Context, stateDir, { runtime: false })
  try {
    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({
      name: "team",
      options: { namespace: "omo", permission: "task" },
    })
  } finally {
    await cleanup()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test("team tool deletes teams and runs the shutdown lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omo team lifecycle "))
  const stateDir = await mkdtemp(join(tmpdir(), "omo team state "))
  let tool: TeamToolHandle | undefined
  const ctx: TeamToolsContext = {
    location: { directory, project: { id: "p", canonical: directory } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        projectID: "p",
        ...(sessionID === "leader" ? {} : { parentID: "leader" }),
      }),
    },
    tool: {
      transform: async (
        callback: (api: { get(): void; add(value: TeamToolHandle): void }) => void,
      ) => {
        callback({
          get() {},
          add(value: TeamToolHandle) {
            tool = value
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  const cleanup = await mountTeams(ctx as unknown as Plugin.Context, stateDir, { runtime: false })
  const handle = (): TeamToolHandle => {
    if (!tool) {
      throw new Error("team tool was not registered")
    }
    return tool
  }
  const call = (sessionID: string, teamID: string, input: Record<string, unknown>) =>
    handle().execute({ teamID, ...input }, { sessionID })
  const bare = (sessionID: string, input: Record<string, unknown>) =>
    handle().execute(input, { sessionID })
  try {
    await call("leader", "t", {
      action: "create",
      members: ["leader", "child"],
      tasks: [{ id: "work", dependencies: [] }],
    })
    const requested = await call("child", "t", { action: "shutdown_request" })
    expect((JSON.parse(requested.content) as { status: string }).status).toBe("shutdown_requested")
    await expect(call("child", "t", { action: "shutdown_approve" })).rejects.toThrow(
      "leader-required",
    )
    const rejected = await call("leader", "t", { action: "shutdown_reject" })
    expect((JSON.parse(rejected.content) as { status: string }).status).toBe("active")
    await expect(call("leader", "t", { action: "shutdown_approve" })).rejects.toThrow(
      "no-shutdown-request",
    )
    await call("child", "t", { action: "shutdown_request" })
    const approved = await call("leader", "t", { action: "shutdown_approve" })
    expect(JSON.parse(approved.content)).toMatchObject({ deleted: "t" })
    await expect(call("leader", "t", { action: "task_list" })).rejects.toThrow("team-not-found")
    await call("leader", "t2", {
      action: "create",
      members: ["leader", "child"],
      tasks: [],
    })
    await expect(call("child", "t2", { action: "delete" })).rejects.toThrow("leader-required")
    const deleted = await call("leader", "t2", { action: "delete" })
    expect(JSON.parse(deleted.content)).toMatchObject({ deleted: "t2" })
    const remaining = await bare("leader", { action: "list" })
    expect(JSON.parse(remaining.content)).toEqual([])
  } finally {
    await cleanup()
    await rm(directory, { recursive: true, force: true })
    await rm(stateDir, { recursive: true, force: true })
  }
})

test("team create rejects consultation agents as leader or member", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omo team eligibility "))
  const stateDir = await mkdtemp(join(tmpdir(), "omo team state "))
  let tool: TeamToolHandle | undefined
  const agents: Record<string, string> = { planner: "prometheus", advisor: "oracle" }
  const ctx: TeamToolsContext = {
    location: { directory, project: { id: "p", canonical: directory } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        projectID: "p",
        ...(sessionID === "leader" || sessionID === "planner" ? {} : { parentID: "leader" }),
        ...(agents[sessionID] ? { agent: agents[sessionID] } : {}),
      }),
    },
    tool: {
      transform: async (
        callback: (api: { get(): void; add(value: TeamToolHandle): void }) => void,
      ) => {
        callback({
          get() {},
          add(value: TeamToolHandle) {
            tool = value
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  const cleanup = await mountTeams(ctx as unknown as Plugin.Context, stateDir, { runtime: false })
  const handle = (): TeamToolHandle => {
    if (!tool) throw new Error("team tool was not registered")
    return tool
  }
  try {
    // A member running a consultation role can never claim progress (`consult-member`).
    await expect(
      handle().execute(
        { action: "create", teamID: "consult-member", members: ["leader", "advisor"], tasks: [] },
        { sessionID: "leader" },
      ),
    ).rejects.toThrow("consult-member: oracle")
    // A consultation role cannot lead a team either (prometheus is plan-mode-only).
    await expect(
      handle().execute(
        { action: "create", teamID: "consult-leader", members: ["planner", "child"], tasks: [] },
        { sessionID: "planner" },
      ),
    ).rejects.toThrow("consult-member: prometheus")
    // Writers remain eligible and agents unknown to the host pass through (fail-open).
    const created = await handle().execute(
      { action: "create", teamID: "ok", members: ["leader", "child"], tasks: [] },
      { sessionID: "leader" },
    )
    expect(JSON.parse(created.content).id).toBe("ok")
  } finally {
    await cleanup()
    await rm(directory, { recursive: true, force: true })
    await rm(stateDir, { recursive: true, force: true })
  }
})
