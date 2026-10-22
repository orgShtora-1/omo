import { describe, expect, test } from "bun:test"
import type { Mcp } from "@opencode/plugin"
import { diagnose, REQUIRED_CAPABILITIES } from "../../src/doctor/diagnose"
import { SDK_FLOOR, VERIFIED_HOST } from "../../src/doctor/host"
import {
  buildMcpChecks,
  buildSkillsCapabilityCheck,
  type McpRegistrationObservation,
  SKILLS_MCP_SERVER_TOOLS,
  SKILLS_MCP_TOOLS,
  SKILLS_TOOL_PREFIX,
} from "../../src/doctor/mcp"
import type { SkillsContribution } from "../../src/mcp/registry"

/** A fully compatible environment: every observation is positive. */
function compatible() {
  return {
    host: { name: "opencode", version: "2.0.15", channel: "stable" },
    sdkVersion: "2.0.24",
    runtimeVersion: "1.4.2",
    capabilities: [...REQUIRED_CAPABILITIES],
    models: [{ providerID: "opencode", modelID: "muse", variants: [] as string[] }],
    git: { available: true as const, version: "2.55.0" },
    optional: { lsp: { available: true as const }, tmux: { available: false as const } },
    pendingPermissions: [{ id: "ask-1", action: "subagent", resources: ["session:ses_1"] }],
  }
}

const inputs = {
  app: (value: { name: string; version: string; channel: string }) => value,
  // The observed environment: host 2.0.15 with SDK 2.0.24. Host and SDK floors
  // are separate inputs; neither is inferred from the other.
  requiredHost: "2.0.15",
  readSdkVersion: async () => "2.0.24",
  readRuntimeVersion: async () => "1.4.2",
  observeCapabilities: () => [...REQUIRED_CAPABILITIES],
  listModels: async () => [{ providerID: "opencode", modelID: "muse", variants: [] as string[] }],
  probeGit: async () => ({ available: true as const, version: "2.55.0" }) as const,
  probeOptional: async (name: "lsp" | "tmux") =>
    name === "lsp"
      ? ({ available: true } as const)
      : ({ available: false, reason: "tmux is not installed" } as const),
  listPendingPermissions: async () => [
    { id: "ask-1", action: "subagent", resources: ["session:ses_1"] },
  ],
}

describe("doctor compatibility diagnosis (F1)", () => {
  // Tripwire: the floor the report judges against must be the version this
  // build actually depends on. A dependency bump without a floor bump would
  // otherwise silently start passing an incompatible host.
  test("the SDK floor matches the pinned dependency", async () => {
    const manifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
      dependencies: Record<string, string>
    }
    const pinned = manifest.dependencies["@opencode/plugin"]
    if (pinned === undefined) throw new Error("test invariant: @opencode/plugin pin is missing")
    expect(SDK_FLOOR).toBe(pinned)
    // The verified baseline is the host observed by the end-to-end live
    // delegation probe on 2026-10-18. host and supported SDK remain separate.
    expect(VERIFIED_HOST).toBe("2.0.32")
  })

  test("reports every check pass on a compatible environment", async () => {
    const report = await diagnose({ ...inputs, app: compatible().host, requiredSdk: "2.0.24" })
    expect(report.schemaVersion).toBe(1)
    expect(report.status).toBe("ok")
    // Absent tmux is reported as skipped, so "every check passes" would be a
    // false claim; every required check must pass.
    expect(report.checks.every((check) => !check.required || check.status === "pass")).toBe(true)
    const host = report.checks.find((check) => check.id === "host-version")
    expect(host?.observed?.version).toBe("2.0.15")
  })

  test("marks an incompatible host version as required-failure with remediation", async () => {
    const report = await diagnose({
      ...inputs,
      app: { name: "opencode", version: "1.0.0", channel: "stable" },
      requiredSdk: "2.0.24",
    })
    expect(report.status).toBe("fail")
    const host = report.checks.find((check) => check.id === "host-version")
    expect(host?.status).toBe("fail")
    expect(host?.required).toBe(true)
    expect(host?.remediation).toContain("opencode")
  })

  test("treats an unparsable version as inconclusive, never as pass or fail", async () => {
    const report = await diagnose({
      ...inputs,
      app: { name: "opencode", version: "not-a-version", channel: "dev" },
      requiredSdk: "2.0.24",
    })
    const host = report.checks.find((check) => check.id === "host-version")
    expect(host?.status).toBe("unknown")
    expect(host?.required).toBe(true)
    // "Could not verify" must never read as an all-clear.
    expect(report.status).not.toBe("ok")
  })

  test("reports a missing model as fail while other checks keep their own status", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      requiredModels: [{ providerID: "opencode", modelID: "absent" }],
    })
    const models = report.checks.find((check) => check.id === "models")
    expect(models?.status).toBe("fail")
    expect(models?.remediation).toContain("absent")
  })

  test("empty model catalogue is reported as unavailable rather than silently fine", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      listModels: async () => [],
    })
    const models = report.checks.find((check) => check.id === "models")
    expect(models?.status).toBe("fail")
    expect(models?.observed?.count).toBe(0)
  })

  test("missing git degrades only the git-dependent checks, never independent features", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      probeGit: async () =>
        ({ available: false, reason: "git is not installed" }) as {
          available: false
          reason: string
        },
    })
    expect(report.status).not.toBe("ok")
    const git = report.checks.find((check) => check.id === "git")
    expect(git?.status).toBe("fail")
    expect(git?.required).toBe(false)
    // Memory, sessions and plans do not require git: they stay available, and
    // exactly the git-dependent features are named as blocked.
    expect(report.independentFeatures).toContain("memory")
    expect(report.independentFeatures).toContain("plans")
    expect(report.blockedFeatures).toEqual(["worktrees", "memory-commit"])
    expect(report.independentFeatures).not.toContain("worktrees")
  })

  test("absent optional service is reported without blocking independent features", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
    })
    const tmux = report.checks.find((check) => check.id === "optional-tmux")
    expect(tmux?.status).toBe("skipped")
    expect(tmux?.required).toBe(false)
    expect(tmux?.observed?.reason).toContain("not installed")
    const lsp = report.checks.find((check) => check.id === "optional-lsp")
    expect(lsp?.status).toBe("pass")
  })

  test("a required capability missing from the host surface is a confirmed incompatibility", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      observeCapabilities: () => ["session.context", "tool.hook"], // two of nine
    })
    const capabilities = report.checks.find((check) => check.id === "capabilities")
    expect(capabilities?.status).toBe("fail")
    expect(capabilities?.observed?.missing).toEqual(
      REQUIRED_CAPABILITIES.filter((id) => id !== "session.context" && id !== "tool.hook"),
    )
  })

  test("pending permission requests are observed asks, never an authorization claim", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
    })
    const permissions = report.checks.find((check) => check.id === "permissions")
    expect(permissions?.status).toBe("pass")
    // permission.list returns asks (id/action/resources); it returns no effect.
    expect(permissions?.observed?.pending).toEqual([
      { id: "ask-1", action: "subagent", resources: ["session:ses_1"] },
    ])
    expect(permissions?.observed?.count).toBe(1)
    expect(permissions?.observed?.authorized).toBeUndefined()
    expect(permissions?.note).toContain("does not imply")
  })

  test("a probe that throws is inconclusive and never fails the whole run", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      probeGit: async () => {
        throw new Error("spawn EPERM")
      },
    })
    const git = report.checks.find((check) => check.id === "git")
    expect(git?.status).toBe("unknown")
    expect(git?.observed?.reason).toContain("EPERM")
    expect(report.status).not.toBe("fail")
  })

  test("never mutates state, never creates permission requests, stays read-only", async () => {
    let permissionCalls = 0
    await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      listPendingPermissions: async () => {
        permissionCalls += 1
        return [{ id: "ask-1", action: "subagent", resources: ["session:ses_1"] }]
      },
    })
    // Exactly one read of the permission surface; no create/reply happened.
    expect(permissionCalls).toBe(1)
  })

  test("an aborted signal stops the run and reports cancellation instead of results", async () => {
    const controller = new AbortController()
    controller.abort()
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      signal: controller.signal,
    })
    expect(report.status).toBe("cancelled")
    expect(report.checks).toEqual([])
  })

  test("every pending request is reported verbatim with its resources", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      listPendingPermissions: async () => [
        { id: "ask-2", action: "edit", resources: ["file:src/index.ts"] },
        { id: "ask-3", action: "bash", resources: ["git status"] },
      ],
    })
    const permissions = report.checks.find((check) => check.id === "permissions")
    expect(permissions?.observed?.pending).toEqual([
      { id: "ask-2", action: "edit", resources: ["file:src/index.ts"] },
      { id: "ask-3", action: "bash", resources: ["git status"] },
    ])
    expect(permissions?.observed?.count).toBe(2)
  })
})

describe("doctor live MCP states", () => {
  const registration = (
    overrides: Partial<McpRegistrationObservation> = {},
  ): McpRegistrationObservation => ({
    enabled: true,
    disabledServers: [],
    problems: [],
    ...overrides,
  })

  const server = (name: string, status: Mcp.Status["status"]): Mcp.Server => ({
    name,
    status:
      status === "failed" || status === "needs_auth"
        ? { status, error: "fixture host error" }
        : { status },
  })

  test("without a live observer the report names the missing capability", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
    })
    const mcp = report.checks.find((check) => check.id === "mcp")
    expect(mcp?.status).toBe("skipped")
    expect(mcp?.required).toBe(false)
    expect(mcp?.remediation).toContain("ctx.mcp.list")
    expect(mcp?.note).toContain("automatic MCP registration")
    expect(mcp?.remediation).not.toContain("examples/opencode.jsonc")
  })

  test("automatic registration makes a missing expected server visible instead of assuming it", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      listMcpServers: async () => [server("github", "connected")],
      mcpRegistration: registration(),
    })
    expect(report.checks.find((check) => check.id === "mcp-github")?.status).toBe("pass")
    for (const id of ["mcp-context7", "mcp-skills"]) {
      const check = report.checks.find((check) => check.id === id)
      expect(check?.status).toBe("fail")
      expect(check?.required).toBe(false)
      expect(check?.remediation).toContain("Restart")
    }
    expect(report.checks.find((check) => check.id === "mcp-optional")).toBeUndefined()
    expect(report.status).toBe("degraded")
  })

  test("pending and safely disabled servers degrade no required capability", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      listMcpServers: async () => [
        server("github", "connected"),
        server("context7", "pending"),
        server("skills", "disabled"),
      ],
      mcpRegistration: registration({
        problems: [{ name: "skills", missingEnvironment: ["OMO_SKILLS_TOKEN"] }],
      }),
    })
    expect(report.checks.find((check) => check.id === "mcp-context7")?.status).toBe("skipped")
    const skills = report.checks.find((check) => check.id === "mcp-skills")
    expect(skills?.status).toBe("skipped")
    expect(skills?.observed?.missingEnvironment).toEqual(["OMO_SKILLS_TOKEN"])
    expect(JSON.stringify(skills)).not.toContain("secret")
  })

  test("failed and unauthorized live states fail without exposing the host error", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      listMcpServers: async () => [
        server("github", "failed"),
        server("context7", "needs_auth"),
        server("skills", "connected"),
      ],
      mcpRegistration: registration(),
    })
    expect(report.checks.find((check) => check.id === "mcp-github")?.status).toBe("fail")
    expect(report.checks.find((check) => check.id === "mcp-context7")?.status).toBe("fail")
    expect(report.checks.find((check) => check.id === "mcp-skills")?.status).toBe("pass")
    expect(JSON.stringify(report)).not.toContain("fixture host error")
    expect(JSON.stringify(report)).not.toContain("examples/opencode.jsonc")
  })

  test("globally disabled automatic registration explains absent servers", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      listMcpServers: async () => [],
      mcpRegistration: registration({ enabled: false }),
    })
    for (const id of ["mcp-github", "mcp-context7", "mcp-skills"]) {
      const check = report.checks.find((check) => check.id === id)
      expect(check?.status).toBe("skipped")
      expect(check?.observed?.automaticRegistration).toBe(false)
    }
    expect(report.status).not.toBe("fail")
  })

  test("opt-in servers report live connection state when present", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      listMcpServers: async () => [
        server("github", "connected"),
        server("context7", "connected"),
        server("skills", "connected"),
        server("vercel", "connected"),
      ],
      mcpRegistration: registration(),
    })
    const optional = report.checks.find((check) => check.id === "mcp-optional")
    expect(optional?.status).toBe("pass")
    expect(optional?.observed?.connected).toEqual(["vercel"])
  })

  test("an unreadable live MCP list is unknown, never a failure", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      listMcpServers: async () => {
        throw new Error("EACCES")
      },
      mcpRegistration: registration(),
    })
    const mcp = report.checks.find((check) => check.id === "mcp")
    expect(mcp?.status).toBe("unknown")
    expect(mcp?.required).toBe(false)
    expect(report.status).not.toBe("fail")
  })

  test("the pure check builder keeps every automatic server optional", () => {
    const checks = buildMcpChecks([], registration(), { packageManager: "bun" })
    expect(checks.every((check) => check.required === false)).toBe(true)
    expect(checks.map((check) => check.id)).toEqual(["mcp-github", "mcp-context7", "mcp-skills"])
  })

  test("the skills remediation uses the configured package manager runner", () => {
    const npm = buildMcpChecks([], registration(), { packageManager: "npm" }).find(
      (check) => check.id === "mcp-skills",
    )
    expect(npm?.remediation).toContain("npx -y @shtora/skills@0.1.0")
    const bun = buildMcpChecks([], registration(), { packageManager: "bun" }).find(
      (check) => check.id === "mcp-skills",
    )
    expect(bun?.remediation).toContain("bunx @shtora/skills@0.1.0")
    const yarn = buildMcpChecks([], registration(), { packageManager: "yarn" }).find(
      (check) => check.id === "mcp-skills",
    )
    expect(yarn?.remediation).toContain("yarn dlx @shtora/skills@0.1.0")
    const pnpm = buildMcpChecks([], registration(), { packageManager: "pnpm" }).find(
      (check) => check.id === "mcp-skills",
    )
    expect(pnpm?.remediation).toContain("pnpm dlx @shtora/skills@0.1.0")
  })
})

describe("doctor skills capability check", () => {
  const contribution = (overrides: Partial<SkillsContribution> = {}): SkillsContribution => ({
    origin: "omo",
    command: ["bunx", "@shtora/skills@0.1.0"],
    pinned: true,
    mutationsEnabled: false,
    projectRootConfigured: true,
    ...overrides,
  })

  const registration = (
    overrides: Partial<McpRegistrationObservation> = {},
  ): McpRegistrationObservation => ({
    enabled: true,
    disabledServers: [],
    problems: [],
    skills: contribution(),
    ...overrides,
  })

  const server = (name: string, status: Mcp.Status["status"]): Mcp.Server => ({
    name,
    status:
      status === "failed" || status === "needs_auth"
        ? { status, error: "fixture host error" }
        : { status },
  })

  test("passes on the full 0.1.0 tool catalog with the safe registration facts", () => {
    const check = buildSkillsCapabilityCheck(
      [server("skills", "connected")],
      registration(),
      SKILLS_MCP_TOOLS.map((name) => ({ name })),
    )
    expect(check.status).toBe("pass")
    expect(check.required).toBe(false)
    expect(check.observed?.tools).toBe(10)
    expect(check.observed?.origin).toBe("omo")
    expect(check.observed?.pinned).toBe(true)
    expect(check.observed?.mutationsEnabled).toBe(false)
    expect(JSON.stringify(check)).not.toContain("secret")
  })

  test("fails on a discovery-only legacy catalog with cache/restart remediation", () => {
    const legacy = SKILLS_MCP_TOOLS.slice(0, 5)
    const check = buildSkillsCapabilityCheck(
      [server("skills", "connected")],
      registration(),
      legacy.map((name) => ({ name })),
    )
    expect(check.status).toBe("fail")
    expect(check.remediation).toContain("cache")
    expect(check.remediation).toContain("restart")
  })

  test("fails when a connected skills server exposes no skills tools", () => {
    const check = buildSkillsCapabilityCheck([server("skills", "connected")], registration(), [
      { name: "unrelated_tool" },
    ])
    expect(check.status).toBe("fail")
  })

  test("skips when the skills server is not connected or registration is disabled", () => {
    const pending = buildSkillsCapabilityCheck(
      [server("skills", "pending")],
      registration(),
      SKILLS_MCP_TOOLS.map((name) => ({ name })),
    )
    expect(pending.status).toBe("skipped")
    expect(pending.observed?.server).toBe("pending")

    const disabled = buildSkillsCapabilityCheck(
      [server("skills", "connected")],
      registration({ enabled: false, disabledServers: ["skills"] }),
      SKILLS_MCP_TOOLS.map((name) => ({ name })),
    )
    expect(disabled.status).toBe("skipped")
    expect(disabled.observed?.server).toBe("disabled")
  })

  test("reports an unexpected catalog as unknown, never as pass", () => {
    const unexpected = [...SKILLS_MCP_TOOLS.slice(0, 3), "skills_mystery_tool"]
    const check = buildSkillsCapabilityCheck(
      [server("skills", "connected")],
      registration(),
      unexpected.map((name) => ({ name })),
    )
    expect(check.status).toBe("unknown")
    // Legacy prefixed entries are unwrapped to the effective raw tool names.
    expect(check.observed?.tools).toEqual([...SKILLS_MCP_SERVER_TOOLS.slice(0, 3), "mystery_tool"])
  })

  test("host-owned skills entries keep capability facts as observed context", () => {
    const check = buildSkillsCapabilityCheck(
      [server("skills", "connected")],
      registration({ skills: { origin: "host" } }),
      SKILLS_MCP_TOOLS.map((name) => ({ name })),
    )
    expect(check.status).toBe("pass")
    expect(check.observed?.origin).toBe("host")
    expect(check.observed).not.toHaveProperty("command")
  })

  test("passes on the namespaced raw catalog the live host registry exposes", () => {
    const check = buildSkillsCapabilityCheck(
      [server("skills", "connected")],
      registration(),
      SKILLS_MCP_SERVER_TOOLS.map((name) => ({ name, namespace: "skills" })),
    )
    expect(check.status).toBe("pass")
    expect(check.observed?.tools).toBe(10)
    expect(check.observed?.server).toBe("connected")
    expect(check.observed?.extra).toEqual([])
  })

  test("attributes tools to the skills server by namespace, never by raw name", () => {
    const check = buildSkillsCapabilityCheck([server("skills", "connected")], registration(), [
      { name: "get_skill", namespace: "other" },
      { name: "skills_get_skill", namespace: "other" },
    ])
    expect(check.status).toBe("fail")
    expect(check.observed?.tools).toBe(0)
  })

  test("fails on a namespaced discovery-only legacy catalog with the cache remediation", () => {
    const legacy = SKILLS_MCP_SERVER_TOOLS.slice(0, 5)
    const check = buildSkillsCapabilityCheck(
      [server("skills", "connected")],
      registration(),
      legacy.map((name) => ({ name, namespace: "skills" })),
    )
    expect(check.status).toBe("fail")
    expect(check.remediation).toContain("cache")
  })

  test("reports extra namespaced tools as extras on a pass", () => {
    const check = buildSkillsCapabilityCheck([server("skills", "connected")], registration(), [
      ...SKILLS_MCP_SERVER_TOOLS.map((name) => ({ name, namespace: "skills" })),
      { name: "future_tool", namespace: "skills" },
    ])
    expect(check.status).toBe("pass")
    expect(check.observed?.extra).toEqual(["future_tool"])
  })

  test("keeps the prefixed permission names and the raw registry catalog in sync", () => {
    expect(SKILLS_MCP_TOOLS.map((name) => name.slice(SKILLS_TOOL_PREFIX.length))).toEqual([
      ...SKILLS_MCP_SERVER_TOOLS,
    ])
  })

  test("diagnose observes the live tool catalog when the host exposes it", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      listMcpServers: async () => [server("skills", "connected")],
      listTools: async () => SKILLS_MCP_TOOLS.map((name) => ({ name })),
      mcpRegistration: registration(),
    })
    const capability = report.checks.find((check) => check.id === "mcp-skills-capability")
    expect(capability?.status).toBe("pass")
    expect(capability?.required).toBe(false)
  })

  test("diagnose passes namespaced registry tools through to the capability check", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      listMcpServers: async () => [server("skills", "connected")],
      listTools: async () => SKILLS_MCP_SERVER_TOOLS.map((name) => ({ name, namespace: "skills" })),
      mcpRegistration: registration(),
    })
    const capability = report.checks.find((check) => check.id === "mcp-skills-capability")
    expect(capability?.status).toBe("pass")
    expect(capability?.observed?.tools).toBe(10)
    expect(capability?.observed?.server).toBe("connected")
  })

  test("an unreadable live tool list is unknown, never a failure", async () => {
    const report = await diagnose({
      ...inputs,
      app: compatible().host,
      requiredSdk: "2.0.24",
      listMcpServers: async () => [server("skills", "connected")],
      listTools: async () => {
        throw new Error("EACCES")
      },
      mcpRegistration: registration(),
    })
    const capability = report.checks.find((check) => check.id === "mcp-skills-capability")
    expect(capability?.status).toBe("unknown")
    expect(report.status).not.toBe("fail")
  })
})
