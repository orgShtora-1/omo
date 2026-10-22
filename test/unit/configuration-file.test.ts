import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadOmoConfig } from "../../src/config/file"
import { parseJSONC } from "../../src/config/jsonc"

const roots: string[] = []
test("a project without a host config uses the global one, but omo.jsonc stays in the config home", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo global config "))
  roots.push(root)
  const global = join(root, "global")
  const workspace = join(root, "workspace")
  const configHome = await home()
  await mkdir(global)
  await mkdir(workspace)
  await writeFile(join(global, "opencode.jsonc"), "{}")
  const loaded = await loadOmoConfig({
    directory: workspace,
    globalConfigDirectory: global,
    configHome,
  })
  expect(loaded.path).toBe(join(configHome, "omo.jsonc"))
  expect(loaded.hostConfigPath).toBe(join(global, "opencode.jsonc"))
  expect(loaded.created).toBe(true)
  await writeFile(join(workspace, "opencode.jsonc"), "{}")
  const reloaded = await loadOmoConfig({
    directory: workspace,
    globalConfigDirectory: global,
    configHome,
  })
  expect(reloaded.path).toBe(join(configHome, "omo.jsonc"))
  expect(reloaded.hostConfigPath).toBe(join(workspace, "opencode.jsonc"))
  expect(reloaded.created).toBe(false)
})
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function project() {
  const root = await mkdtemp(join(tmpdir(), "omo config "))
  roots.push(root)
  await writeFile(join(root, "opencode.jsonc"), "{ /* user host */ }")
  await mkdir(join(root, "nested"))
  return root
}
async function home() {
  const configHome = await mkdtemp(join(tmpdir(), "omo config "))
  roots.push(configHome)
  return configHome
}

test("discovers the nearest host configuration and creates omo.jsonc in the config home without changing the host", async () => {
  const root = await project()
  const configHome = await home()
  const loaded = await loadOmoConfig({ directory: join(root, "nested"), configHome })
  expect(loaded.path).toBe(join(configHome, "omo.jsonc"))
  expect(loaded.hostConfigPath).toBe(join(root, "opencode.jsonc"))
  expect(loaded.created).toBe(true)
  expect(loaded.options.schemaVersion).toBe(1)
  expect(await readFile(join(root, "opencode.jsonc"), "utf8")).toBe("{ /* user host */ }")
  expect((await loadOmoConfig({ directory: root, configHome })).created).toBe(false)
})

test("JSONC keeps URLs, escaped quotes and comment markers inside strings; refuses malformed documents", () => {
  expect(
    parseJSONC(
      '\uFEFF{ /* note */ "url": "https://host/a,]//b", "quote": "\\"/*literal*/", "items": [1, /* end */], }',
    ),
  ).toEqual({
    url: "https://host/a,]//b",
    quote: '"/*literal*/',
    items: [1],
  })
  for (const source of [
    '{"x": [,]}',
    '{"x": [1,,]}',
    '{"x": ,}',
    "/* unclosed",
    '{"x":"bad\\q"}',
  ]) {
    expect(() => parseJSONC(source)).toThrow()
  }
})

test("existing commented configuration is preserved, models are validated, and explicit options win", async () => {
  const root = await project()
  const configHome = await home()
  const text =
    '{ // retain this comment\n "schemaVersion": 1, "agents": { "sisyphus": {"model":"test/deep#high"}, }, "allowedModels": ["test/deep#high"], "execution": {"maxChildren": 2,}, }'
  await writeFile(join(configHome, "omo.jsonc"), text)
  const loaded = await loadOmoConfig({
    directory: root,
    configHome,
    overrides: { execution: { maxChildren: 4 } },
    availableModels: [{ providerID: "test", modelID: "deep", variant: "high" }],
  })
  expect(loaded.created).toBe(false)
  expect(loaded.resolved.execution.maxChildren).toBe(4)
  expect(loaded.resolved.profiles).toContainEqual({
    id: "sisyphus",
    mode: "primary",
    allowWrite: true,
    model: { providerID: "test", modelID: "deep", variant: "high" },
  })
  await expect(loadOmoConfig({ directory: root, configHome, availableModels: [] })).rejects.toThrow(
    "unavailable",
  )
  await expect(
    loadOmoConfig({
      directory: root,
      configHome,
      overrides: { agents: { sisyphus: { model: "test/other" } } },
    }),
  ).rejects.toThrow("allowedModels")
  expect(await readFile(join(configHome, "omo.jsonc"), "utf8")).toBe(text)
})

test("corrupt existing configuration is an actionable error and remains byte-for-byte intact", async () => {
  const root = await project()
  const configHome = await home()
  await writeFile(join(configHome, "omo.jsonc"), '{"schemaVersion": 1, /* unfinished')
  await expect(loadOmoConfig({ directory: root, configHome })).rejects.toThrow(
    "unterminated comment",
  )
  expect(await readFile(join(configHome, "omo.jsonc"), "utf8")).toBe(
    '{"schemaVersion": 1, /* unfinished',
  )
})

test("MCP overrides merge by server, retaining other presets and replacing credential maps atomically", async () => {
  const root = await project()
  const configHome = await home()
  const text = JSON.stringify({
    schemaVersion: 1,
    mcp: {
      enabled: false,
      servers: {
        github: { disabled: true, headers: { Authorization: "Bearer {env:OLD_TOKEN}" } },
        skills: { command: ["custom-skills"] },
      },
    },
  })
  await writeFile(join(configHome, "omo.jsonc"), text)
  const loaded = await loadOmoConfig({
    directory: root,
    configHome,
    overrides: {
      mcp: {
        servers: {
          github: { url: "https://new.example/mcp", headers: {} },
          vercel: { disabled: false },
        },
      },
    },
  })
  expect(loaded.resolved.mcp).toMatchObject({
    enabled: false,
    servers: {
      github: { disabled: true, url: "https://new.example/mcp", headers: {} },
      skills: { command: ["custom-skills"], disabled: false },
      vercel: { disabled: false },
      context7: { disabled: false },
    },
  })
  expect(await readFile(join(configHome, "omo.jsonc"), "utf8")).toBe(text)
  expect(await readFile(join(root, "opencode.jsonc"), "utf8")).toBe("{ /* user host */ }")
})

test("repeating the built-in endpoint does not discard credentials the file configured", async () => {
  const root = await project()
  const configHome = await home()
  await writeFile(
    join(configHome, "omo.jsonc"),
    JSON.stringify({
      schemaVersion: 1,
      mcp: {
        servers: {
          github: { headers: { Authorization: "Bearer {env:OMO_FILE_TOKEN}" } },
        },
      },
    }),
  )
  const loaded = await loadOmoConfig({
    directory: root,
    configHome,
    overrides: {
      mcp: { servers: { github: { url: "https://api.githubcopilot.com/mcp/" } } },
    },
  })
  expect(loaded.resolved.mcp.servers.github.headers).toEqual({
    Authorization: "Bearer {env:OMO_FILE_TOKEN}",
  })
})

test("changing an MCP endpoint discards inherited credentials unless explicitly supplied again", async () => {
  const root = await project()
  const configHome = await home()
  await writeFile(
    join(configHome, "omo.jsonc"),
    JSON.stringify({
      schemaVersion: 1,
      mcp: {
        servers: {
          github: {
            url: "https://original.example/mcp",
            headers: { Authorization: "Bearer {env:ORIGINAL_TOKEN}" },
            oauth: { client_secret: "{env:ORIGINAL_SECRET}" },
          },
        },
      },
    }),
  )
  const loaded = await loadOmoConfig({
    directory: root,
    configHome,
    overrides: {
      mcp: { servers: { github: { url: "https://replacement.example/mcp" } } },
    },
  })
  expect(loaded.resolved.mcp.servers.github).not.toHaveProperty("headers")
  expect(loaded.resolved.mcp.servers.github).not.toHaveProperty("oauth")
})

test("concurrent initializers create the global omo.jsonc once; explicit host path and .opencode discovery agree", async () => {
  const root = await project()
  const configHome = await home()
  await mkdir(join(root, "nested", ".opencode"))
  const host = join(root, "nested", ".opencode", "opencode.json")
  await writeFile(host, "{}")
  const loaded = await Promise.all([
    loadOmoConfig({ directory: join(root, "nested"), configHome }),
    loadOmoConfig({ directory: root, hostConfigPath: host, configHome }),
  ])
  expect(loaded.map((result) => result.created).filter(Boolean)).toHaveLength(1)
  expect(loaded.map((result) => result.path)).toEqual([
    join(configHome, "omo.jsonc"),
    join(configHome, "omo.jsonc"),
  ])
  expect(loaded.map((result) => result.hostConfigPath)).toEqual([host, host])
})

test("all .opencode configs outrank direct configs, and the nearest .opencode wins within that tier", async () => {
  const root = await project()
  const configHome = await home()
  await mkdir(join(root, ".opencode"))
  await writeFile(join(root, ".opencode", "opencode.jsonc"), "{}")
  await writeFile(join(root, "nested", "opencode.jsonc"), "{}")
  expect(
    (await loadOmoConfig({ directory: join(root, "nested"), configHome })).hostConfigPath,
  ).toBe(join(root, ".opencode", "opencode.jsonc"))
  await mkdir(join(root, "nested", ".opencode"))
  await writeFile(join(root, "nested", ".opencode", "opencode.json"), "{}")
  expect(
    (await loadOmoConfig({ directory: join(root, "nested"), configHome })).hostConfigPath,
  ).toBe(join(root, "nested", ".opencode", "opencode.json"))
})

test("a missing config home is created and a legacy omo.jsonc beside the host config is inert", async () => {
  const root = await project()
  const configHome = join(await home(), "fresh", "home")
  const legacy = join(root, "omo.jsonc")
  await writeFile(legacy, '{"schemaVersion": 99, "memory_enabled": true}')
  const loaded = await loadOmoConfig({ directory: root, configHome })
  expect(loaded.created).toBe(true)
  expect(loaded.path).toBe(join(configHome, "omo.jsonc"))
  expect(loaded.options.schemaVersion).toBe(1)
  expect(await readFile(legacy, "utf8")).toBe('{"schemaVersion": 99, "memory_enabled": true}')
})

test("a missing config-home omo.jsonc falls back to a legacy file read-only", async () => {
  const root = await project()
  const configHome = join(root, "config-home")
  const legacy = join(root, "legacy-home", "omo.jsonc")
  await mkdir(join(root, "legacy-home"))
  await writeFile(legacy, '{ "schemaVersion": 1, "memory_enabled": true }')
  const loaded = await loadOmoConfig({ directory: root, configHome, legacyConfigPath: legacy })
  expect(loaded.created).toBe(false)
  expect(loaded.path).toBe(legacy)
  expect(loaded.resolved.memory_enabled).toBe(true)
  expect(existsSync(join(configHome, "omo.jsonc"))).toBe(false)
  expect(await readFile(legacy, "utf8")).toBe('{ "schemaVersion": 1, "memory_enabled": true }')
})
