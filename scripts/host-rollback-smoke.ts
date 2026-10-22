import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openBoulderStore } from "../src/boulder/store"
import { goalDirectory, openGoalStore } from "../src/goal/store"
import { openReflectionQueue } from "../src/memory/reflection-queue"
import { memoryScope, openMemoryStore } from "../src/memory/store"
import { createPlan } from "../src/plans/model"
import { backupState, restoreState } from "../src/state/backup"
import { projectStateHome } from "../src/state/home"
import { openPlanRepository } from "../src/state/repository"
import {
  assertSmokeAgentsRegistered,
  assertSmokeAgentsRestored,
  nativeSmokeAgents,
} from "./smoke-agents"
import { installTimeoutMs, packSmokeTarball, runSmokeCommand } from "./smoke-package"

// Isolated-host reinstall/rollback gate; no provider, credentials or global
// config required. Seeds source-defined state fixtures, unloads the installed plugin,
// restores a backup over simulated loss, reinstalls and proves the state
// round-tripped with the plugin active again.
const base =
  process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Temp", "opencode")
    : tmpdir()
await mkdir(base, { recursive: true })
const sandbox = await mkdtemp(join(base, "omo-host-rollback-"))
const project = join(sandbox, "project")
const inherited: NodeJS.ProcessEnv = { ...process.env }
for (const key of [
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG",
  "OPENCODE_SERVER",
  "OPENCODE_SERVER_URL",
  "OPENCODE_CONFIG_DIR",
])
  delete inherited[key]
const omoHomeDir = join(sandbox, "omo-home")
const env = {
  ...inherited,
  HOME: join(sandbox, "home"),
  USERPROFILE: join(sandbox, "home"),
  OMO_HOME: omoHomeDir,
  OMO_CONFIG_HOME: join(sandbox, "config", "opencode"),
  BUN_INSTALL_CACHE_DIR: join(sandbox, "bun-cache"),
  XDG_CONFIG_HOME: join(sandbox, "config"),
  XDG_DATA_HOME: join(sandbox, "data"),
  XDG_STATE_HOME: join(sandbox, "state"),
  XDG_CACHE_HOME: join(sandbox, "cache"),
  OPENCODE_DB: join(sandbox, "data", "probe.db"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "true",
  OPENCODE_CONFIG: join(project, "opencode.jsonc"),
  OPENCODE_SERVER_PASSWORD: crypto.randomUUID(),
}

async function run(command: string[], cwd = project) {
  return runSmokeCommand(command, { cwd, env, timeoutMs: 120_000 })
}

const evidence: Record<string, unknown> = { sandbox, project, assertions: [] }
const artifact = join(base, "omo-host-rollback-smoke-evidence.json")
let server: ReturnType<typeof Bun.spawn> | undefined
try {
  await mkdir(project, { recursive: true })
  for (const path of [
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
    env.XDG_CACHE_HOME,
  ])
    await mkdir(path, { recursive: true })
  const packed = await packSmokeTarball(sandbox, env)
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@shtora/omo": `file:${join(sandbox, packed.filename).replaceAll("\\", "/")}`,
      },
    }),
  )
  const installStarted = Date.now()
  await runSmokeCommand([process.execPath, "install", "--ignore-scripts"], {
    cwd: project,
    env,
    timeoutMs: installTimeoutMs,
  })
  evidence.installDurationMs = Date.now() - installStarted
  evidence.package = { name: packed.name, version: packed.version }
  const packagePath = join(project, "node_modules", "@shtora", "omo")

  // Use source-defined fixtures before the installed plugin ever opens state.
  // The plugin resolves this same state home through OMO_HOME at load time.
  const omo = projectStateHome(omoHomeDir, project)
  await mkdir(omo, { recursive: true })
  const scope = { projectID: "project", locationID: "loc", parentSessionID: "parent" }
  const seedPlans = openPlanRepository(join(omo, "plans.sqlite"))
  await seedPlans.save(
    scope,
    createPlan({
      id: "rollback-plan",
      projectID: "project",
      parentSessionID: "parent",
      at: 1,
      steps: [{ id: "build", objective: "Build", dependencies: [] }],
    }),
    null,
  )
  seedPlans.close()
  const seedMemory = openMemoryStore(join(omo, "memory.sqlite"))
  seedMemory.save(memoryScope("project", "loc"), { content: "rollback canary", key: "canary" })
  seedMemory.close()
  openGoalStore(goalDirectory(omo)).set("session-1", "Survive the reinstall cycle")
  openReflectionQueue(omo, "scope").enqueue({
    sessionID: "session-1",
    text: "snapshot text",
    trigger: "manual",
  })
  await writeFile(join(project, "PLAN.md"), "# plan\n")
  openBoulderStore(omo, { projectRoot: project }).start("session-1", "PLAN.md")
  evidence.seeded = "plan+memory+goal+queue+boulder written with source-defined state fixtures"

  const backupDir = join(sandbox, "backup")
  const manifest = backupState(omo, backupDir, { pluginVersion: packed.version })
  evidence.backupFiles = manifest.files.length

  const pluginConfig = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [{ package: packagePath.replaceAll("\\", "/"), options: { schemaVersion: 1 } }],
  })
  await writeFile(join(project, "opencode.jsonc"), JSON.stringify({ plugins: [] }))
  const query = `?location[directory]=${encodeURIComponent(project)}`
  server = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const ready = async () => {
    let text = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("Private server exited before listening")
      text += decoder.decode(chunk.value)
      const match = /server listening on (http:\/\/[^\s]+)/.exec(text)
      const listening = match?.[1]
      if (listening) return listening
    }
  }
  const timer = setTimeout(() => server?.kill(), 30_000)
  let url: string
  try {
    url = await ready()
  } finally {
    clearTimeout(timer)
  }
  void (async () => {
    while (!(await reader.read()).done) {}
  })().catch(() => {})
  void new Response(server.stderr as ReadableStream<Uint8Array>).text()
  const api = async (path: string, method = "get", body?: unknown) => {
    const output = await run([
      "opencode",
      "api",
      "--server",
      url,
      method,
      path + query,
      ...(body === undefined ? [] : ["--data", JSON.stringify(body)]),
    ])
    return output ? JSON.parse(output) : undefined
  }
  const waitActive = async () => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const plugins = await api("/api/plugin")
      const plugin = plugins.data?.find((item: { id: string }) => item.id === "shtora.omo")
      if (plugin?.state?.status === "active") return
      if (plugin && plugin.state?.status !== "loading")
        throw new Error(`Installed plugin status: ${plugin.state?.status}`)
      await Bun.sleep(250)
    }
    throw new Error("Installed plugin not active within 20 seconds")
  }
  const statusOnce = async () => {
    const session = (await api("/api/session", "post", { title: "Rollback probe" })) as {
      data: { id: string }
    }
    await api(`/api/session/${session.data.id}/command`, "post", { name: "omo-status", text: "" })
    const messages = await api(`/api/session/${session.data.id}/inbox`)
    if (!JSON.stringify(messages).includes("OMO command result"))
      throw new Error("Status command did not persist its native synthetic result")
  }
  await api("/api/location/reload", "post")
  const baselineAgents = await nativeSmokeAgents(api)
  evidence.nativeAgentIDs = baselineAgents.map((agent) => agent.id)
  await writeFile(join(project, "opencode.jsonc"), pluginConfig)
  await api("/api/location/reload", "post")
  await waitActive()
  assertSmokeAgentsRegistered((await api("/api/agent")).data ?? [])
  if (!(await Bun.file(join(env.OMO_CONFIG_HOME, "omo.jsonc")).exists()))
    throw new Error("Installed plugin did not create its isolated configuration")
  evidence.omoPaths = { home: env.OMO_HOME, config: env.OMO_CONFIG_HOME }
  await statusOnce()
  evidence.mount = "plugin active with seeded state; status command persisted output"

  // Unload the plugin, simulate state loss, restore the backup.
  await writeFile(join(project, "opencode.jsonc"), JSON.stringify({ plugins: [] }))
  await api("/api/location/reload", "post")
  await api("/api/session", "post", { title: "Unload rollback probe" })
  const afterUnload = await nativeSmokeAgents(api)
  assertSmokeAgentsRestored(afterUnload, baselineAgents)
  await rm(join(omo, "goal"), { recursive: true, force: true })
  let restored = false
  let lastError: unknown
  for (let attempt = 0; attempt < 3 && !restored; attempt++) {
    try {
      restoreState(backupDir, omo)
      restored = true
    } catch (error) {
      lastError = error
      await Bun.sleep(1000)
    }
  }
  if (!restored) throw lastError
  evidence.restore = "goal loss restored from hash-verified backup while plugin unloaded"

  // Reinstall and prove the state round-tripped with the plugin active again.
  await writeFile(join(project, "opencode.jsonc"), pluginConfig)
  await api("/api/location/reload", "post")
  await waitActive()
  assertSmokeAgentsRegistered((await api("/api/agent")).data ?? [])
  await statusOnce()
  const verifyPlans = openPlanRepository(join(omo, "plans.sqlite"))
  const reloaded = await verifyPlans.load(scope, "rollback-plan")
  verifyPlans.close()
  if (reloaded?.steps.map((step) => step.id).join(",") !== "build")
    throw new Error("Seeded plan did not survive the unload/restore/reinstall cycle")
  const verifyMemory = openMemoryStore(join(omo, "memory.sqlite"))
  const recalled = verifyMemory.recall(memoryScope("project", "loc"), "canary")
  verifyMemory.close()
  if (!recalled.some((item) => item.key === "canary"))
    throw new Error("Seeded memory did not survive the unload/restore/reinstall cycle")
  if (
    openGoalStore(goalDirectory(omo)).get("session-1")?.objective !== "Survive the reinstall cycle"
  )
    throw new Error("Restored goal not visible after reinstall")
  evidence.roundTrip = "plan+memory+goal readable with reactivated plugin"
  evidence.assertions = [
    "source-defined state fixtures seeded before installed plugin startup",
    "hash-manifest backup captured all state files",
    "plugin active with seeded state mounted",
    "plugin profiles unloaded and native explore restored via native reload",
    "simulated goal loss restored from verified backup",
    "reinstalled plugin active with 17 unique profiles; plan, memory and goal intact",
  ]
  evidence.result = "passed"
  console.log(`Host rollback cycle passed; evidence: ${artifact}`)
} catch (error) {
  evidence.result = "failed"
  evidence.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  if (server) {
    if (process.platform === "win32") {
      const stop = Bun.spawn(["taskkill", "/PID", String(server.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      })
      await stop.exited
    } else server.kill()
    await server.exited
  }
  await writeFile(artifact, JSON.stringify(evidence, null, 2))
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
