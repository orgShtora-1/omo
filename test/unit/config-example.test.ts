import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadOmoConfig } from "../../src/config/file"
import { parseJSONC } from "../../src/config/jsonc"
import { resolveOptions } from "../../src/config/resolve"
import { parseOptions } from "../../src/config/schema"

// The shipped reference must preserve its declared options through JSONC,
// schema validation and resolution, including the consolidated task profile.

const exampleURL = new URL("../../examples/omo.jsonc", import.meta.url)

test("shipped omo.jsonc example resolves through the file pipeline", async () => {
  const source = await Bun.file(exampleURL).text()
  expect(source).toContain("//")
  const resolved = resolveOptions(parseOptions(parseJSONC(source, "omo.jsonc")))
  expect(resolved.schemaVersion).toBe(1)
  expect(resolved.execution.maxChildren).toBe(3)
  expect(resolved.execution.timeoutMs).toBe(1_200_000)
  expect(resolved.execution.maxRetries).toBe(2)
  expect(resolved.execution.maxAttempts).toBe(3)
  expect(resolved.execution.fallback).toBe(false)
  expect(resolved.skills).toEqual({
    recommendedLimit: 5,
    auto: true,
    required: [],
    autoInstall: true,
    requireAuditPass: true,
    strictAudits: false,
  })
  expect(resolved.profiles).toEqual([
    { id: "planner", mode: "subagent", allowWrite: false, model: undefined },
  ])
  expect(resolved.categories).toEqual([{ id: "investigate", agent: "planner" }])
  expect(resolved.mcp.enabled).toBe(true)
  expect(resolved.mcp.servers.github.disabled).toBe(false)
  expect(resolved.mcp.servers.context7.disabled).toBe(false)
  expect(resolved.mcp.servers.skills.disabled).toBe(false)
  expect(resolved.mcp.servers.vercel.disabled).toBe(true)
  expect(resolved.mcp.servers.cloudflare.disabled).toBe(true)
})

test("feature flags round-trip through file text", () => {
  const resolved = resolveOptions(
    parseOptions(
      parseJSONC(
        '{ "schemaVersion": 1, "hashline_edit": true, "memory_enabled": true, "goal_enabled": true }',
        "omo.jsonc",
      ),
    ),
  )
  expect(resolved.hashline_edit).toBe(true)
  expect(resolved.memory_enabled).toBe(true)
  expect(resolved.goal_enabled).toBe(true)
})

test("flags set only in the global configuration file reach resolution; explicit overrides win", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo config flags "))
  try {
    const configHome = join(root, "home")
    await mkdir(configHome)
    await writeFile(join(root, "opencode.jsonc"), "{}")
    await writeFile(
      join(configHome, "omo.jsonc"),
      '{ "schemaVersion": 1, "memory_enabled": true, "execution": { "maxChildren": 2 } }',
    )
    const fromFile = await loadOmoConfig({ directory: root, configHome })
    expect(fromFile.created).toBe(false)
    expect(fromFile.resolved.memory_enabled).toBe(true)
    expect(fromFile.resolved.execution.maxChildren).toBe(2)
    const overridden = await loadOmoConfig({
      directory: root,
      configHome,
      overrides: { memory_enabled: false },
    })
    expect(overridden.resolved.memory_enabled).toBe(false)
    expect(overridden.resolved.execution.maxChildren).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
