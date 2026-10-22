import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import {
  assertSmokeAgentsRegistered,
  assertSmokeAgentsRestored,
  nativeSmokeAgents,
} from "./smoke-agents"
import { installTimeoutMs, packSmokeTarball, runSmokeCommand } from "./smoke-package"

// Real-host registration gate; no provider, credentials or global config required.
// This is deliberately not an end-to-end model/delegation success claim.
const base =
  process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Temp", "opencode")
    : tmpdir()
await mkdir(base, { recursive: true })
const sandbox = await mkdtemp(join(base, "omo-host-package-"))
const project = join(sandbox, "project")
const inherited: NodeJS.ProcessEnv = { ...process.env }
// Inline config and server overrides from the calling session must not leak in.
for (const key of [
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG",
  "OPENCODE_SERVER",
  "OPENCODE_SERVER_URL",
  "OPENCODE_CONFIG_DIR",
])
  delete inherited[key]
const env = {
  ...inherited,
  HOME: join(sandbox, "home"),
  USERPROFILE: join(sandbox, "home"),
  OMO_HOME: join(sandbox, "omo-home"),
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
  return runSmokeCommand(command, { cwd, env })
}

const evidence: Record<string, unknown> = { sandbox, project, assertions: [] }
const artifact = join(base, "omo-host-package-smoke-evidence.json")
let server: ReturnType<typeof Bun.spawn> | undefined
try {
  await mkdir(project)
  for (const path of [
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
    env.XDG_CACHE_HOME,
  ])
    await mkdir(path, { recursive: true })
  const paths: Record<string, string> = {}
  for (const name of ["home", "db", "config", "data", "state", "cache"]) {
    const path = await run(["opencode", "debug", "paths", name])
    const rel = relative(sandbox, resolve(path))
    if (rel.startsWith("..") || resolve(path) === resolve(sandbox))
      throw new Error(`Host ${name} path is not isolated: ${path}`)
    paths[name] = path
  }
  evidence.paths = paths
  evidence.hostVersion = await run(["opencode", "--version"])
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
  const packagePath = join(project, "node_modules", "@shtora", "omo")
  const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8"))
  evidence.package = {
    name: manifest.name,
    version: manifest.version,
    sdk: manifest.dependencies["@opencode/plugin"],
    files: packed.files.length,
  }
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
  // Drain pipes without recording passwords, prompts or server logs.
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
  await api("/api/location/reload", "post")
  const baselineAgents = await nativeSmokeAgents(api)
  evidence.nativeAgentIDs = baselineAgents.map((agent) => agent.id)
  await writeFile(join(project, "opencode.jsonc"), pluginConfig)
  await api("/api/location/reload", "post")
  const config = await api("/api/config")
  evidence.configSources = config.map((entry: { type: string; path?: string }) => ({
    type: entry.type,
    path: entry.path,
  }))
  for (const entry of config) {
    if (entry.path && relative(sandbox, resolve(entry.path)).startsWith(".."))
      throw new Error("Host discovered configuration outside the isolated sandbox")
  }
  evidence.session = await api("/api/session", "post", {
    title: "Installed package registration probe",
  })
  const deadline = Date.now() + 20_000
  let active = false
  while (Date.now() < deadline) {
    const plugins = await api("/api/plugin")
    evidence.plugins = plugins
    const plugin = plugins.data?.find((item: { id: string }) => item.id === "shtora.omo")
    if (plugin?.state?.status === "active") {
      active = true
      break
    }
    if (plugin && plugin.state?.status !== "loading")
      throw new Error(`Installed plugin status: ${plugin.state?.status}`)
    await Bun.sleep(250)
  }
  if (!active) throw new Error("Installed plugin not active within 20 seconds")
  if (!(await Bun.file(join(env.OMO_CONFIG_HOME, "omo.jsonc")).exists()))
    throw new Error("Installed plugin did not create its isolated configuration")
  evidence.omoPaths = { home: env.OMO_HOME, config: env.OMO_CONFIG_HOME }
  const agents = await api("/api/agent")
  const ids = agents.data?.map((item: { id: string }) => item.id) ?? []
  assertSmokeAgentsRegistered(agents.data ?? [])
  const explore = agents.data.find((item: { id: string }) => item.id === "explore")
  for (const action of ["edit", "shell", "subagent"])
    if (
      !explore.permissions.some(
        (rule: { action: string; resource: string; effect: string }) =>
          rule.action === action && rule.resource === "*" && rule.effect === "deny",
      )
    )
      throw new Error(`Installed explore lacks the ${action} denial`)
  evidence.agentIDs = ids
  const commands = await api("/api/command")
  const names = commands.data?.map((item: { name: string }) => item.name) ?? []
  for (const name of ["omo-status", "omo-cancel", "omo-doctor"])
    if (!names.includes(name)) throw new Error(`Missing installed command: ${name}`)
  evidence.commandNames = names
  const sessionID = (evidence.session as { data: { id: string } }).data.id
  await api(`/api/session/${sessionID}/command`, "post", { name: "omo-status", text: "" })
  const messages = await api(`/api/session/${sessionID}/inbox`)
  if (!JSON.stringify(messages).includes("OMO command result"))
    throw new Error("Registered status command did not persist its native synthetic result")
  evidence.statusCommand = "native synthetic result persisted without provider call"
  await writeFile(join(project, "opencode.jsonc"), JSON.stringify({ plugins: [] }))
  await api("/api/location/reload", "post")
  await api("/api/session", "post", { title: "Unload registration probe" })
  const afterUnload = await nativeSmokeAgents(api)
  assertSmokeAgentsRestored(afterUnload, baselineAgents)
  const commandsAfterUnload = await api("/api/command")
  if (commandsAfterUnload.data?.some((item: { name: string }) => item.name.startsWith("omo-")))
    throw new Error("Plugin commands survived removal and native location reload")
  evidence.unload = "custom profiles absent; native explore restored after native reload"
  evidence.assertions = [
    "all host paths isolated before API startup",
    "actual tarball installed",
    "all 17 profiles registered once with no legacy task IDs",
    "installed explore denies edit, shell and subagent",
    "installed plugin commands registered by real host",
    "status command persisted native synthetic output",
    "custom registrations removed and native explore restored on native location reload",
  ]
  evidence.result = "passed"
  console.log(`Real-host package registration passed; evidence: ${artifact}`)
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
