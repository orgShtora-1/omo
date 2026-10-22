import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Mcp, Plugin } from "@opencode/plugin"
import sourcePlugin from "../../src/index"

type McpEditor = Parameters<Parameters<Plugin.Context["mcp"]["transform"]>[0]>[0]
type MutableServerConfig = NonNullable<ReturnType<McpEditor["get"]>>

const directories: string[] = []
const originalEnvironment = Object.fromEntries(
  [
    "OMO_HOME",
    "OMO_CONFIG_HOME",
    "GITHUB_API_KEY",
    "CONTEXT7_API_KEY",
    "OMO_TEST_MCP_TOKEN",
    "OMO_TEST_MCP_MISSING",
    "OMO_TEST_MCP_URL",
    "VERCEL_OIDC_TOKEN",
    "OMO_TEST_MCP_DOTENV_ONLY",
  ].map((key) => [key, process.env[key]]),
)
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

// T01: importa o package compilado (dist/index.js) e exige export default
// de plugin válido com setup/cleanup. RED enquanto dist não existir.
describe("package compilado", () => {
  test("dist/index.js exporta default plugin com setup função", async () => {
    const mod = await import("../../dist/index.js")
    expect(mod.default).toBeDefined()
    expect(typeof mod.default.setup).toBe("function")
  })

  test("cleanup do setup é idempotente", async () => {
    const mod = await import("../../dist/index.js")
    const cleanup = await mod.default.setup(fakeCtx() as unknown as Plugin.Context)
    if (typeof cleanup === "function") {
      await cleanup()
      await cleanup()
    }
  })
})

test("invalid options fail setup before any host registration", async () => {
  const ctx = fakeCtx()
  let registrations = 0
  ctx.options = { schemaVersion: 9 }
  ctx.agent.transform = async () => {
    registrations++
    return { dispose: async () => {} }
  }
  await expect(sourcePlugin.setup(ctx as unknown as Plugin.Context)).rejects.toMatchObject({
    path: "schemaVersion",
  })
  expect(registrations).toBe(0)
})

test("default setup registers suite profiles once", async () => {
  const ctx = fakeCtx()
  let registrations = 0
  ctx.agent.transform = async () => {
    registrations++
    return { dispose: async () => {} }
  }
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect(registrations).toBe(1)
    expect(existsSync(join(process.env.OMO_CONFIG_HOME ?? "", "omo.jsonc"))).toBe(true)
    expect(ctx.tools.has("omo_parallel")).toBe(true)
    expect(ctx.commands.has("omo-status")).toBe(true)
  } finally {
    await cleanup?.()
  }
})

test("default setup contributes MCPs without host configuration and removes them on cleanup", async () => {
  const ctx = fakeCtx()
  const hostPath = join(ctx.location.directory, "opencode.jsonc")
  const before = readFileSync(hostPath, "utf8")
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect(ctx.mcpServers.get("skills")).toMatchObject({
      type: "local",
      command: ["bunx", "@shtora/skills@0.1.0"],
      environment: {
        SKILLS_ALLOW_MUTATIONS: "false",
        SKILLS_PROJECT_ROOT: ctx.location.directory,
      },
    })
    expect(ctx.mcpServers.get("github")).toMatchObject({
      type: "remote",
      url: "https://api.githubcopilot.com/mcp/",
    })
    expect(ctx.mcpServers.get("context7")).toMatchObject({
      type: "remote",
      url: "https://mcp.context7.com/mcp",
    })
    expect(ctx.mcpServers.has("vercel")).toBe(false)
    expect(ctx.mcpServers.has("cloudflare")).toBe(false)
    expect(readFileSync(hostPath, "utf8")).toBe(before)
  } finally {
    await cleanup?.()
  }
  await cleanup?.()
  expect(ctx.mcpServers.size).toBe(0)
})

test("MCP registration preserves existing host entries, including disabled servers, across replay and cleanup", async () => {
  const ctx = fakeCtx()
  const github: Mcp.ServerConfig = {
    type: "remote",
    url: "https://user.example/mcp",
    disabled: true,
  }
  const skills: Mcp.ServerConfig = { type: "local", command: ["user-skills"] }
  const configHome = process.env.OMO_CONFIG_HOME
  if (!configHome) throw new Error("test invariant: isolated config home is unset")
  writeFileSync(join(configHome, ".env"), "VERCEL_OIDC_TOKEN=fixture-not-for-user-server\n")
  ctx.options = {
    schemaVersion: 1,
    mcp: { servers: { skills: { environment: { VERCEL_OIDC_TOKEN: "{env:VERCEL_OIDC_TOKEN}" } } } },
  }
  ctx.hostMcpServers.set("github", github)
  ctx.hostMcpServers.set("skills", skills)
  ctx.hostMcpServers.set("unrelated", { type: "local", command: ["user-server"] })
  await ctx.mcp.reload()
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    await ctx.mcp.reload()
    expect(ctx.mcpServers.size).toBe(4)
    expect(ctx.mcpServers.get("github")).toEqual(github)
    expect(ctx.mcpServers.get("skills")).toEqual(skills)
  } finally {
    await cleanup?.()
  }
  expect([...ctx.mcpServers.keys()].sort()).toEqual(["github", "skills", "unrelated"])
})

test("global MCP opt-out leaves host servers untouched", async () => {
  const ctx = fakeCtx()
  const configHome = process.env.OMO_CONFIG_HOME
  if (!configHome) throw new Error("test invariant: isolated config home is unset")
  mkdirSync(join(configHome, ".env"))
  ctx.options = { schemaVersion: 1, mcp: { enabled: false } }
  ctx.hostMcpServers.set("github", { type: "remote", url: "https://user.example/mcp" })
  await ctx.mcp.reload()
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect([...ctx.mcpServers.keys()]).toEqual(["github"])
  } finally {
    await cleanup?.()
  }
  expect([...ctx.mcpServers.keys()]).toEqual(["github"])
})

test("omo.jsonc configures the automatic MCPs, with plugin options overriding individual presets", async () => {
  const ctx = fakeCtx()
  const configHome = process.env.OMO_CONFIG_HOME
  if (!configHome) throw new Error("test invariant: isolated config home is unset")
  const path = join(configHome, "omo.jsonc")
  const contents = JSON.stringify({
    schemaVersion: 1,
    runtime: { packageManager: "npm" },
    mcp: {
      servers: {
        github: { disabled: true },
        vercel: { disabled: false, url: "https://custom.example/mcp" },
      },
    },
  })
  writeFileSync(path, contents)
  ctx.options = { schemaVersion: 1, mcp: { servers: { context7: { disabled: true } } } }
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect([...ctx.mcpServers.keys()].sort()).toEqual(["skills", "vercel"])
    expect(ctx.mcpServers.get("skills")).toMatchObject({
      command: ["npx", "-y", "@shtora/skills@0.1.0"],
    })
    expect(ctx.mcpServers.get("vercel")).toMatchObject({ url: "https://custom.example/mcp" })
    expect(readFileSync(path, "utf8")).toBe(contents)
  } finally {
    await cleanup?.()
  }
})

test("implicit service credentials are used only for canonical preset endpoints", async () => {
  process.env.GITHUB_API_KEY = "fixture-github-token"
  process.env.CONTEXT7_API_KEY = "fixture-context7-token"
  const ctx = fakeCtx()
  ctx.options = {
    schemaVersion: 1,
    mcp: { servers: { github: { url: "https://custom.example/mcp" }, context7: { headers: {} } } },
  }
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect(ctx.mcpServers.get("github")).not.toHaveProperty("headers")
    expect(ctx.mcpServers.get("context7")).toMatchObject({ headers: {} })
  } finally {
    await cleanup?.()
  }
  ctx.options = { schemaVersion: 1 }
  const canonicalCleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect(ctx.mcpServers.get("github")).toMatchObject({
      oauth: false,
      headers: { Authorization: "Bearer fixture-github-token" },
    })
    const context7 = ctx.mcpServers.get("context7")
    expect(context7).toMatchObject({ headers: { Authorization: "Bearer fixture-context7-token" } })
    if (context7?.type !== "remote") throw new Error("test invariant: context7 must be remote")
    expect(context7.headers).not.toHaveProperty("CONTEXT7_API_KEY")
  } finally {
    await canonicalCleanup?.()
  }
})

test("explicit OAuth does not inherit a GitHub PAT and explicit environment references are resolved before registration", async () => {
  process.env.GITHUB_API_KEY = "fixture-unwanted-token"
  process.env.OMO_TEST_MCP_TOKEN = "fixture-explicit-token"
  const ctx = fakeCtx()
  ctx.options = {
    schemaVersion: 1,
    mcp: {
      servers: {
        github: { oauth: { client_id: "fixture-client" } },
        skills: {
          command: ["server", "{env:OMO_TEST_MCP_TOKEN}"],
          environment: { TOKEN: "{env:OMO_TEST_MCP_TOKEN}" },
        },
      },
    },
  }
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect(ctx.mcpServers.get("github")).toMatchObject({ oauth: { client_id: "fixture-client" } })
    expect(ctx.mcpServers.get("github")).not.toHaveProperty("headers")
    expect(ctx.mcpServers.get("skills")).toMatchObject({
      command: ["server", "fixture-explicit-token"],
      environment: {
        TOKEN: "fixture-explicit-token",
        SKILLS_ALLOW_MUTATIONS: "false",
      },
    })
  } finally {
    await cleanup?.()
  }
})

test("MCP references read .env beside omo.jsonc without exporting secrets globally", async () => {
  delete process.env.VERCEL_OIDC_TOKEN
  delete process.env.OMO_TEST_MCP_DOTENV_ONLY
  const ctx = fakeCtx()
  const configHome = process.env.OMO_CONFIG_HOME
  if (!configHome) throw new Error("test invariant: isolated config home is unset")
  const configPath = join(configHome, "omo.jsonc")
  const contents = JSON.stringify({
    schemaVersion: 1,
    mcp: {
      servers: {
        skills: { environment: { VERCEL_OIDC_TOKEN: "{env:VERCEL_OIDC_TOKEN}" } },
      },
    },
  })
  writeFileSync(configPath, contents)
  writeFileSync(
    join(configHome, ".env"),
    'export VERCEL_OIDC_TOKEN="fixture-dotenv-token" # optional skills credential\r\nOMO_TEST_MCP_DOTENV_ONLY=fixture-private\r\n',
  )
  writeFileSync(join(ctx.location.directory, ".env"), "VERCEL_OIDC_TOKEN=wrong-project-token\n")
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    await ctx.mcp.reload()
    expect(ctx.mcpServers.get("skills")).toMatchObject({
      disabled: false,
      environment: { VERCEL_OIDC_TOKEN: "fixture-dotenv-token" },
    })
    expect(ctx.mcpServers.get("skills")).not.toHaveProperty("environment.OMO_TEST_MCP_DOTENV_ONLY")
    expect(process.env.VERCEL_OIDC_TOKEN).toBeUndefined()
    expect(process.env.OMO_TEST_MCP_DOTENV_ONLY).toBeUndefined()
    expect(readFileSync(configPath, "utf8")).toBe(contents)
    expect(readFileSync(join(ctx.location.directory, "opencode.jsonc"), "utf8")).toBe("{}")
  } finally {
    await cleanup?.()
  }
})

test.each(["fixture-process-token", ""])(
  "MCP process environment takes precedence over .env (%j)",
  async (token) => {
    process.env.VERCEL_OIDC_TOKEN = token
    const ctx = fakeCtx()
    const configHome = process.env.OMO_CONFIG_HOME
    if (!configHome) throw new Error("test invariant: isolated config home is unset")
    writeFileSync(join(configHome, ".env"), "VERCEL_OIDC_TOKEN=fixture-dotenv-token\n")
    ctx.options = {
      schemaVersion: 1,
      mcp: {
        servers: { skills: { environment: { VERCEL_OIDC_TOKEN: "{env:VERCEL_OIDC_TOKEN}" } } },
      },
    }
    const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
    try {
      expect(ctx.mcpServers.get("skills")).toMatchObject({
        disabled: token === "",
        environment: { VERCEL_OIDC_TOKEN: token },
      })
      expect(process.env.VERCEL_OIDC_TOKEN).toBe(token)
    } finally {
      await cleanup?.()
    }
  },
)

test("legacy configuration resolves references from its own adjacent .env", async () => {
  delete process.env.VERCEL_OIDC_TOKEN
  const ctx = fakeCtx()
  const legacyHome = process.env.OMO_HOME
  if (!legacyHome) throw new Error("test invariant: isolated legacy home is unset")
  const primaryHome = join(legacyHome, "primary")
  mkdirSync(primaryHome)
  process.env.OMO_CONFIG_HOME = primaryHome
  const legacyPath = join(legacyHome, "omo.jsonc")
  const contents = JSON.stringify({
    schemaVersion: 1,
    mcp: { servers: { skills: { environment: { VERCEL_OIDC_TOKEN: "{env:VERCEL_OIDC_TOKEN}" } } } },
  })
  writeFileSync(legacyPath, contents)
  writeFileSync(join(legacyHome, ".env"), "VERCEL_OIDC_TOKEN=fixture-legacy-token\n")
  writeFileSync(join(primaryHome, ".env"), "VERCEL_OIDC_TOKEN=wrong-primary-token\n")
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect(ctx.mcpServers.get("skills")).toMatchObject({
      environment: { VERCEL_OIDC_TOKEN: "fixture-legacy-token" },
    })
    expect(existsSync(join(primaryHome, "omo.jsonc"))).toBe(false)
    expect(readFileSync(legacyPath, "utf8")).toBe(contents)
  } finally {
    await cleanup?.()
  }
})

test(".env credentials are not forwarded to skills without an explicit environment mapping", async () => {
  delete process.env.VERCEL_OIDC_TOKEN
  const ctx = fakeCtx()
  const configHome = process.env.OMO_CONFIG_HOME
  if (!configHome) throw new Error("test invariant: isolated config home is unset")
  writeFileSync(join(configHome, ".env"), "VERCEL_OIDC_TOKEN=fixture-not-requested\n")
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    const skills = ctx.mcpServers.get("skills")
    expect(skills).toMatchObject({ disabled: false })
    if (skills?.type !== "local") throw new Error("test invariant: skills must be local")
    expect(skills.environment).toEqual({
      SKILLS_ALLOW_MUTATIONS: "false",
      SKILLS_PROJECT_ROOT: ctx.location.directory,
    })
    expect(process.env.VERCEL_OIDC_TOKEN).toBeUndefined()
  } finally {
    await cleanup?.()
  }
})

test("skills environment mapping merges per key over the safe defaults", async () => {
  const ctx = fakeCtx()
  ctx.options = {
    schemaVersion: 1,
    mcp: {
      servers: {
        skills: {
          environment: {
            VERCEL_OIDC_TOKEN: "direct-token",
            SKILLS_ALLOW_MUTATIONS: "true",
          },
        },
      },
    },
  }
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    const skills = ctx.mcpServers.get("skills")
    if (skills?.type !== "local") throw new Error("test invariant: skills must be local")
    expect(skills.command).toEqual(["bunx", "@shtora/skills@0.1.0"])
    expect(skills.environment).toEqual({
      SKILLS_ALLOW_MUTATIONS: "true",
      SKILLS_PROJECT_ROOT: ctx.location.directory,
      VERCEL_OIDC_TOKEN: "direct-token",
    })
  } finally {
    await cleanup?.()
  }
})

test("an absent .env and explicit missing token disable only skills", async () => {
  delete process.env.VERCEL_OIDC_TOKEN
  const ctx = fakeCtx()
  ctx.options = {
    schemaVersion: 1,
    mcp: { servers: { skills: { environment: { VERCEL_OIDC_TOKEN: "{env:VERCEL_OIDC_TOKEN}" } } } },
  }
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect(ctx.mcpServers.get("skills")).toMatchObject({ disabled: true })
    expect(ctx.mcpServers.get("github")).toMatchObject({ disabled: false })
    expect(ctx.mcpServers.get("context7")).toMatchObject({ disabled: false })
    expect(ctx.tools.has("omo_delegate")).toBe(true)
  } finally {
    await cleanup?.()
  }
})

test("an unreadable .env fails setup with a safe error before host registration", async () => {
  const ctx = fakeCtx()
  const configHome = process.env.OMO_CONFIG_HOME
  if (!configHome) throw new Error("test invariant: isolated config home is unset")
  const path = join(configHome, ".env")
  mkdirSync(path)
  await expect(sourcePlugin.setup(ctx as unknown as Plugin.Context)).rejects.toMatchObject({
    path,
    message: `${path}: could not read MCP environment file`,
  })
  expect(ctx.mcpServers.size).toBe(0)
  expect(ctx.tools.size).toBe(0)
})

test("an environment-supplied endpoint is resolved before registration", async () => {
  process.env.OMO_TEST_MCP_URL = "https://fixture.example/mcp"
  const ctx = fakeCtx()
  ctx.options = {
    schemaVersion: 1,
    mcp: { servers: { github: { url: "{env:OMO_TEST_MCP_URL}" } } },
  }
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect(ctx.mcpServers.get("github")).toMatchObject({
      url: "https://fixture.example/mcp",
      disabled: false,
    })
  } finally {
    await cleanup?.()
  }
})

test("an unresolved explicit environment reference disables only its server", async () => {
  delete process.env.OMO_TEST_MCP_MISSING
  const ctx = fakeCtx()
  ctx.options = {
    schemaVersion: 1,
    mcp: {
      servers: {
        github: { oauth: false, headers: { Authorization: "Bearer {env:OMO_TEST_MCP_MISSING}" } },
      },
    },
  }
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect(ctx.mcpServers.get("github")).toMatchObject({ disabled: true })
    expect(ctx.mcpServers.get("skills")).toMatchObject({ disabled: false })
    expect(ctx.tools.has("omo_delegate")).toBe(true)
  } finally {
    await cleanup?.()
  }
})

test("default setup registers the blocked-runs panel next to the existing suite tools", async () => {
  const ctx = fakeCtx()
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect(ctx.tools.has("omo_doctor")).toBe(true)
    expect(ctx.tools.get("omo_blocked")).toMatchObject({
      name: "blocked",
      options: { namespace: "omo", permission: "read" },
    })
  } finally {
    await cleanup?.()
  }
})

test("default setup registers the revision-linkage tool beside the same read-only suite", async () => {
  const ctx = fakeCtx()
  const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
  try {
    expect(ctx.tools.get("omo_revision")).toMatchObject({
      name: "revision",
      options: { namespace: "omo", permission: "read" },
    })
  } finally {
    await cleanup?.()
  }
})

for (const options of [{}, { temperature: 0.8, maxTokens: 4000 }]) {
  test(`default setup preserves host sampling options ${JSON.stringify(options)}`, async () => {
    const ctx = fakeCtx()
    const callbacks: Array<(input: unknown) => Promise<void> | void> = []
    ctx.session.hook = async (name, callback) => {
      if (name === "generate") callbacks.push(callback)
      return { dispose: async () => {} }
    }
    const cleanup = await sourcePlugin.setup(ctx as unknown as Plugin.Context)
    try {
      for (const agent of ["explore", "librarian", "oracle", "metis"]) {
        const event = { agent, options: { ...options } }
        for (const callback of callbacks) await callback(event)
        expect(event.options).toEqual(options)
      }
    } finally {
      await cleanup?.()
    }
  })
}

// Mínimo estrutural de PluginContext p/ setup não quebrar fora do host.
type FakeToolRecord = { name: string }
type FakeCommandRecord = { name: string }
interface FakeToolApi {
  namespace(): void
  get: (id: string) => Record<string, unknown> | undefined
  add: (tool: FakeToolRecord) => void
}
interface FakeCommandApi {
  add: (command: FakeCommandRecord) => void
}
interface FakePluginContext {
  options?: Record<string, unknown>
  mcp: Plugin.Context["mcp"]
  mcpServers: Map<string, Mcp.ServerConfig>
  hostMcpServers: Map<string, Mcp.ServerConfig>
  tools: Map<string, Record<string, unknown>>
  commands: Map<string, Record<string, unknown>>
  location: { project: { id: string; canonical: string }; directory: string }
  storage: {
    get: () => Promise<null>
    set: () => Promise<void>
    remove: () => Promise<void>
    scan: () => Promise<unknown[]>
  }
  agent: { transform: () => Promise<{ dispose: () => Promise<void> }> }
  model: { list: () => Promise<{ data: unknown[] }> }
  skill: { list: () => Promise<{ data: unknown[] }> }
  tool: {
    transform: (callback: (api: FakeToolApi) => void) => Promise<{ dispose: () => Promise<void> }>
    hook: (
      name: string,
      callback: (input: unknown) => Promise<void> | void,
    ) => Promise<{ dispose: () => Promise<void> }>
  }
  command: {
    transform: (
      callback: (api: FakeCommandApi) => void,
    ) => Promise<{ dispose: () => Promise<void> }>
  }
  session: {
    hook: (
      name: string,
      callback: (input: unknown) => Promise<void> | void,
    ) => Promise<{ dispose: () => Promise<void> }>
  }
  permission: { hook: () => Promise<{ dispose: () => Promise<void> }> }
  event: { subscribe: (input: { signal: AbortSignal }) => AsyncIterable<never> }
}
function fakeCtx(): FakePluginContext {
  const noop = async () => {}
  const directory = mkdtempSync(join(tmpdir(), "omo-package-"))
  directories.push(directory)
  // The plugin resolves state through OMO_HOME and configuration through
  // OMO_CONFIG_HOME; pin both to a sandbox so the test never touches the real
  // ~/.omo or ~/.config/opencode.
  const home = mkdtempSync(join(tmpdir(), "omo-package-home-"))
  directories.push(home)
  process.env.OMO_HOME = home
  process.env.OMO_CONFIG_HOME = home
  writeFileSync(join(directory, "opencode.jsonc"), "{}")
  const tools = new Map<string, Record<string, unknown>>(),
    commands = new Map<string, Record<string, unknown>>()
  const mcpServers = new Map<string, MutableServerConfig>()
  const hostMcpServers = new Map<string, Mcp.ServerConfig>()
  const mcpTransforms = new Set<Parameters<Plugin.Context["mcp"]["transform"]>[0]>()
  const reloadMcp = async () => {
    mcpServers.clear()
    for (const [name, config] of hostMcpServers)
      mcpServers.set(name, structuredClone(config) as MutableServerConfig)
    for (const transform of mcpTransforms)
      transform({
        get: (name) => mcpServers.get(name),
        list: () => [...mcpServers],
        set: (name, config) => {
          mcpServers.set(name, structuredClone(config) as MutableServerConfig)
        },
        remove: (name) => {
          mcpServers.delete(name)
        },
        update: (name, update) => {
          const config = mcpServers.get(name)
          if (config) update(config)
        },
      })
  }
  return {
    tools,
    commands,
    mcpServers,
    hostMcpServers,
    mcp: {
      transform: async (callback) => {
        mcpTransforms.add(callback)
        await reloadMcp()
        return {
          dispose: async () => {
            mcpTransforms.delete(callback)
            await reloadMcp()
          },
        }
      },
      reload: reloadMcp,
      list: async () => ({
        location: { directory },
        data: [...mcpServers].map(([name]) => ({ name, status: { status: "connected" as const } })),
      }),
    },
    location: { project: { id: "test", canonical: directory }, directory },
    storage: { get: async () => null, set: noop, remove: noop, scan: async () => [] },
    agent: { transform: async () => ({ dispose: noop }) },
    model: { list: async () => ({ data: [] }) },
    skill: { list: async () => ({ data: [] }) },
    tool: {
      transform: async (callback: (api: FakeToolApi) => void) => {
        callback({
          namespace() {},
          get: (id: string) => tools.get(id),
          add: (tool: FakeToolRecord) => {
            tools.set(`omo_${tool.name}`, tool)
          },
        })
        return { dispose: async () => tools.clear() }
      },
      hook: async () => ({ dispose: noop }),
    },
    command: {
      transform: async (callback: (api: FakeCommandApi) => void) => {
        callback({
          add: (command: FakeCommandRecord) => {
            commands.set(command.name, command)
          },
        })
        return { dispose: async () => commands.clear() }
      },
    },
    session: { hook: async () => ({ dispose: noop }) },
    permission: { hook: async () => ({ dispose: noop }) },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            )
        },
      }),
    },
  }
}
