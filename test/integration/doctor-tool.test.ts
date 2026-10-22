import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { diagnose } from "../../src/doctor/diagnose"
import { hostDoctorInputs, observeCapabilities } from "../../src/doctor/host"
import { mountDoctor } from "../../src/doctor/tool"

interface DoctorResult {
  content: string
  output?: unknown
}

interface DoctorHandle {
  execute: (
    args: Record<string, unknown>,
    context: { sessionID: string; signal?: AbortSignal },
  ) => Promise<DoctorResult>
}

interface Registration {
  name: string
  options?: { namespace?: string; permission?: string }
}

/** A fake host exposing exactly the domains the doctor reads. */
function host(overrides: Record<string, unknown> = {}) {
  const calls = { modelList: 0, permissionList: 0, permissionReply: 0, permissionGet: 0 }
  const ctx = {
    app: { name: "cli", version: "2.0.32", channel: "latest" },
    session: {
      create: () => {},
      prompt: () => {},
      hook: () => {},
      synthetic: () => {},
      context: () => {},
    },
    tool: { transform: () => {}, hook: () => {} },
    command: { transform: () => {} },
    permission: {
      list: async () => {
        calls.permissionList += 1
        return [
          { id: "ask-1", sessionID: "ses_1", action: "subagent", resources: ["session:ses_1"] },
        ]
      },
      get: async () => {
        calls.permissionGet += 1
        throw new Error("the doctor must not read a single request")
      },
      reply: async () => {
        calls.permissionReply += 1
        throw new Error("the doctor must not reply")
      },
    },
    model: {
      list: async () => {
        calls.modelList += 1
        return {
          data: [
            { providerID: "opencode", id: "muse", variants: { high: {} } },
            { providerID: "openai", id: "gpt-6.1-sol" },
          ],
        }
      },
    },
    mcp: {
      transform: () => {},
      list: async () => ({ data: [] }),
    },
    ...overrides,
  }
  return { ctx: ctx as unknown as Plugin.Context, calls }
}

function toolFixture(ctx: Plugin.Context, collision = false) {
  const registrations: Registration[] = []
  const handle: DoctorHandle = {
    async execute(args, context) {
      const registered = registrations.find((entry) => entry.name === "doctor")
      if (!registered) throw new Error("doctor tool was not registered")
      return (registered as unknown as { execute: DoctorHandle["execute"] }).execute(args, context)
    },
  }
  const toolCtx = {
    tool: {
      transform: async (
        callback: (editor: {
          get(): undefined
          namespace(value: { name: string }): void
          add(value: Registration & DoctorHandle): void
        }) => void,
      ) => {
        callback({
          get: () => (collision ? ({ id: "omo_doctor" } as never) : undefined),
          namespace: () => {},
          add: (value) => registrations.push(value),
        })
        return { dispose: async () => {} }
      },
    },
  }
  void toolCtx
  return {
    registrations,
    mount: () =>
      mountDoctor({
        ...(ctx as unknown as Record<string, unknown>),
        ...toolCtx,
      } as unknown as Plugin.Context),
    handle,
  }
}

test("doctor tool is registered read-only in the omo namespace", async () => {
  const { ctx } = host()
  const fixture = toolFixture(ctx)
  const cleanup = await fixture.mount()
  try {
    expect(fixture.registrations).toHaveLength(1)
    expect(fixture.registrations[0]).toMatchObject({
      name: "doctor",
      options: { namespace: "omo", permission: "read" },
    })
  } finally {
    await cleanup()
  }
})

test("doctor tool refuses to overwrite an existing host tool", async () => {
  const { ctx } = host()
  const fixture = toolFixture(ctx, true)
  await expect(fixture.mount()).rejects.toThrow("doctor tool collision: omo_doctor")
})

test("doctor tool reports capabilities observed from the live context", async () => {
  const { ctx } = host()
  const seen = observeCapabilities(ctx)
  expect(seen).toContain("session.prompt")
  expect(seen).toContain("permission.list")
  expect(seen).toContain("mcp.transform")
  expect(seen).toContain("tool.hook")
})

test("a host missing a required domain reports the capability as absent", async () => {
  const { ctx } = host({ permission: undefined })
  expect(observeCapabilities(ctx)).not.toContain("permission.list")
  // Absent, not crash: the rest of the surface is still observed.
  expect(observeCapabilities(ctx)).toContain("session.prompt")
})

test("doctor inputs read models and pending permissions exactly once, never mutating", async () => {
  const { ctx, calls } = host()
  const inputs = hostDoctorInputs(ctx, "ses_1", { lsp: { enabled: true, servers: [{}] } })
  const models = await inputs.listModels()
  expect(models).toEqual([
    { providerID: "opencode", modelID: "muse", variant: "high" },
    { providerID: "openai", modelID: "gpt-6.1-sol" },
  ])
  const pending = await inputs.listPendingPermissions()
  expect(pending).toEqual([{ id: "ask-1", action: "subagent", resources: ["session:ses_1"] }])
  expect(calls.modelList).toBe(1)
  expect(calls.permissionList).toBe(1)
  expect(calls.permissionGet).toBe(0)
  expect(calls.permissionReply).toBe(0)
})

test("malformed permission entries are dropped instead of reported as asks", async () => {
  const { ctx } = host({
    permission: {
      list: async () => [
        { id: "ask-1", action: "edit", resources: ["file:a.ts"] },
        { action: "no-id" },
        { id: "ask-3" },
        null,
      ],
      get: async () => {
        throw new Error("unused")
      },
      reply: async () => {
        throw new Error("unused")
      },
    },
  })
  const inputs = hostDoctorInputs(ctx, "ses_1")
  expect(await inputs.listPendingPermissions()).toEqual([
    { id: "ask-1", action: "edit", resources: ["file:a.ts"] },
  ])
})

test("a doctor run over the fake host produces a versioned report with no authorization claim", async () => {
  const { ctx, calls } = host()
  const report = await diagnose(
    hostDoctorInputs(ctx, "ses_1", { lsp: { enabled: false, servers: [] } }),
  )
  expect(report.schemaVersion).toBe(1)
  expect(["ok", "degraded"]).toContain(report.status)
  const permissions = report.checks.find((check) => check.id === "permissions")
  expect(permissions?.observed?.pending).toEqual([
    { id: "ask-1", action: "subagent", resources: ["session:ses_1"] },
  ])
  expect(permissions?.note).toContain("does not imply")
  expect(calls.permissionReply).toBe(0)
})

test("the tool output carries the same report as its content", async () => {
  const { ctx } = host()
  const fixture = toolFixture(ctx)
  const cleanup = await fixture.mount()
  try {
    const result = await fixture.handle.execute({}, { sessionID: "ses_1" })
    const parsed = JSON.parse(result.content) as {
      schemaVersion: number
      checks: unknown[]
    }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.checks.length).toBeGreaterThan(0)
    expect(result.output).toEqual(parsed)
  } finally {
    await cleanup()
  }
})

test("an aborted tool call reports cancellation without probes", async () => {
  const { ctx, calls } = host()
  const fixture = toolFixture(ctx)
  const cleanup = await fixture.mount()
  const controller = new AbortController()
  controller.abort()
  try {
    const result = await fixture.handle.execute(
      {},
      { sessionID: "ses_1", signal: controller.signal },
    )
    const parsed = JSON.parse(result.content) as { status: string; checks: unknown[] }
    expect(parsed.status).toBe("cancelled")
    expect(parsed.checks).toEqual([])
    // Cancelled before any observation: the model catalogue was never listed.
    expect(calls.modelList).toBe(0)
  } finally {
    await cleanup()
  }
})

test("lsp absence is reported from configuration and labelled as such", async () => {
  const { ctx } = host()
  const report = await diagnose(
    hostDoctorInputs(ctx, "ses_1", { lsp: { enabled: false, servers: [] } }),
  )
  const lsp = report.checks.find((check) => check.id === "optional-lsp")
  expect(lsp?.status).toBe("skipped")
  expect(lsp?.note).toContain("not a started server")
  expect(lsp?.remediation).toContain("every other feature works")
})

test("a configured lsp server is reported as configured, never as started", async () => {
  const { ctx } = host()
  const report = await diagnose(
    hostDoctorInputs(ctx, "ses_1", { lsp: { enabled: true, servers: [{ id: "ts" }] } }),
  )
  const lsp = report.checks.find((check) => check.id === "optional-lsp")
  expect(lsp?.status).toBe("pass")
  expect(lsp?.observed?.version).toBe("1 configured server(s)")
  expect(lsp?.note).toContain("not a started server")
})

test("the doctor never asserts an authorization even with a pending ask present", async () => {
  const { ctx } = host()
  const report = await diagnose(hostDoctorInputs(ctx, "ses_1"))
  const serialized = JSON.stringify(report)
  expect(serialized).not.toContain('"authorized"')
  expect(serialized).not.toContain('"granted"')
})

test("doctor inputs observe live MCP data for the active location", async () => {
  const calls = { list: 0 }
  const project = await mkdtemp(join(tmpdir(), "omo-mcp-live-"))
  try {
    const { ctx } = host({
      location: { directory: project, project: { canonical: project } },
      mcp: {
        transform: () => {},
        list: async (input: unknown) => {
          calls.list += 1
          expect(input).toEqual({ location: { directory: project } })
          return {
            data: [
              { name: "github", status: { status: "connected" } },
              { name: "skills", status: { status: "needs_auth", error: "fixture auth detail" } },
            ],
          }
        },
      },
    })
    const inputs = hostDoctorInputs(ctx, "ses_1", {
      mcpRegistration: {
        enabled: true,
        disabledServers: [],
        problems: [],
      },
    })
    const servers = await inputs.listMcpServers?.()
    expect(calls.list).toBe(1)
    expect(servers?.map((entry) => entry.name)).toEqual(["github", "skills"])

    const report = await diagnose(inputs)
    expect(report.checks.find((check) => check.id === "mcp-github")?.status).toBe("pass")
    expect(report.checks.find((check) => check.id === "mcp-skills")?.status).toBe("fail")
    expect(JSON.stringify(report)).not.toContain("fixture auth detail")
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test("doctor inputs without ctx.mcp.list keep MCP state unavailable", async () => {
  const { ctx } = host({ mcp: undefined })
  const inputs = hostDoctorInputs(ctx, "ses_1")
  expect(inputs.listMcpServers).toBeUndefined()
  const report = await diagnose(inputs)
  const check = report.checks.find((entry) => entry.id === "mcp")
  expect(check?.status).toBe("skipped")
  expect(check?.remediation).toContain("ctx.mcp.list")
})

test("a live MCP list requires the location directory", async () => {
  const { ctx } = host({
    mcp: {
      transform: () => {},
      list: async () => {
        throw new Error("fixture should not be called")
      },
    },
  })
  const inputs = hostDoctorInputs(ctx, "ses_1")
  expect(inputs.listMcpServers).toBeUndefined()
})

test("doctor inputs preserve the host registry namespace attribution on tools", async () => {
  const { ctx } = host({
    tool: {
      transform: () => {},
      hook: () => {},
      list: async () => ({
        data: [
          { name: "get_official_skills", options: { namespace: "skills", codemode: true } },
          { name: "get_me", options: { namespace: "github" } },
          { name: "legacy_prefixed_tool" },
          { name: "dangling", options: "not-an-object" },
          { name: "bad_namespace", options: { namespace: 7 } },
          "not-an-object",
          { options: { namespace: "skills" } },
        ],
      }),
    },
  })
  const inputs = hostDoctorInputs(ctx, "ses_1")
  const tools = await inputs.listTools?.()
  expect(tools).toEqual([
    { name: "get_official_skills", namespace: "skills" },
    { name: "get_me", namespace: "github" },
    { name: "legacy_prefixed_tool" },
    { name: "dangling" },
    { name: "bad_namespace" },
  ])
})
