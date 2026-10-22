import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { assertSmokeAgentsRegistered, smokeAgentIDs } from "./smoke-agents"
import { installTimeoutMs, packSmokeTarball, runSmokeCommand } from "./smoke-package"

// Isolated-host lifecycle gate: plan create/status/cancel across a server
// restart, proving no duplicate execution and no state loss. No provider,
// credentials, or global config are used; model-backed delegation stays an
// explicit opt-in live step.
const base =
  process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Temp", "opencode")
    : tmpdir()
await mkdir(base, { recursive: true })
const sandbox = await mkdtemp(join(base, "omo-host-lifecycle-"))
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

async function run(command: string[], cwd = project, label?: string) {
  return runSmokeCommand(command, { cwd, env, label })
}

const evidence: Record<string, unknown> = { sandbox, project, assertions: [] }
const artifact = join(base, "omo-host-lifecycle-smoke-evidence.json")
let server: ReturnType<typeof Bun.spawn> | undefined
const query = `?location[directory]=${encodeURIComponent(project)}`
let url = ""
let serverLog = ""
const noteLog = (text: string) => {
  serverLog = `${serverLog}${text}`.slice(-6000)
}

async function stopServer() {
  if (!server) return
  const proc = server
  server = undefined
  if (process.platform === "win32") {
    const stop = Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    await stop.exited
  } else proc.kill()
  await proc.exited
}

function findPayloads(value: unknown, token: string): Record<string, unknown>[] {
  const seen = new Set<unknown>()
  const found: Record<string, unknown>[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const record = node as Record<string, unknown>
    const text = [record.text, record.description].filter((part) => typeof part === "string")
    for (const part of text as string[]) {
      const start = part.indexOf("{")
      if (start < 0) continue
      try {
        const parsed: unknown = JSON.parse(part.slice(start))
        if (parsed && typeof parsed === "object" && JSON.stringify(parsed).includes(token))
          found.push(parsed as Record<string, unknown>)
      } catch {
        // Not a JSON payload; keep searching.
      }
    }
    for (const value of Object.values(record)) visit(value)
  }
  visit(value)
  return found
}

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
  for (const name of ["home", "db", "config", "data", "state", "cache"]) {
    const path = await run(["opencode", "debug", "paths", name])
    const rel = relative(sandbox, resolve(path))
    if (rel.startsWith("..") || resolve(path) === resolve(sandbox))
      throw new Error(`Host ${name} path is not isolated: ${path}`)
  }
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
  evidence.package = { name: manifest.name, version: manifest.version }
  await writeFile(
    join(project, "opencode.jsonc"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugins: [{ package: packagePath.replaceAll("\\", "/"), options: { schemaVersion: 1 } }],
    }),
  )
  const api = async (path: string, method = "get", body?: unknown) => {
    const output = await run(
      [
        "opencode",
        "api",
        "--server",
        url,
        method,
        path + query,
        ...(body === undefined ? [] : ["--data", JSON.stringify(body)]),
      ],
      project,
      `${method} ${path}`,
    )
    return output ? JSON.parse(output) : undefined
  }
  async function startServer() {
    server = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = (server.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    const timer = setTimeout(() => server?.kill(), 30_000)
    try {
      let text = ""
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("Private server exited before listening")
        text += decoder.decode(chunk.value)
        const match = /server listening on (http:\/\/[^\s]+)/.exec(text)
        if (match?.[1]) {
          url = match[1]
          break
        }
      }
    } finally {
      clearTimeout(timer)
    }
    void (async () => {
      const outDecoder = new TextDecoder()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        noteLog(outDecoder.decode(chunk.value))
      }
    })().catch(() => {})
    const stderr = server.stderr as ReadableStream<Uint8Array> | null
    void (async () => {
      if (!stderr) return
      const streamReader = stderr.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const chunk = await streamReader.read()
        if (chunk.done) break
        noteLog(decoder.decode(chunk.value))
      }
    })().catch(() => {})
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
  async function commandResult(sessionID: string, name: string, text: string, token: string) {
    // Baseline the inbox first: polling must observe a payload produced by
    // THIS invocation, never a stale message from an earlier command.
    const before = findPayloads(await api(`/api/session/${sessionID}/inbox`), token).length
    await api(`/api/session/${sessionID}/command`, "post", { name, text })
    const deadline = Date.now() + 20_000
    for (;;) {
      const matches = findPayloads(await api(`/api/session/${sessionID}/inbox`), token)
      if (matches.length > before) return matches[matches.length - 1] as Record<string, unknown>
      if (Date.now() >= deadline) throw new Error(`No lifecycle payload observed for ${name}`)
      await Bun.sleep(500)
    }
  }
  const planArgs = JSON.stringify({
    id: "lc-cycle",
    steps: [
      { id: "a", objective: "First lifecycle step", dependencies: [] },
      { id: "b", objective: "Second lifecycle step", dependencies: ["a"] },
    ],
  })
  const planOf = (status: Record<string, unknown>) => {
    const plans = status.plans as Array<{ id: string }> | undefined
    return plans?.find((plan) => plan.id === "lc-cycle") as
      | { id: string; state?: unknown; steps?: Array<{ id: string; state: string }> }
      | undefined
  }

  await startServer()
  evidence.serverGenerations = 1
  const session = (await api("/api/session", "post", { title: "Lifecycle probe" })) as {
    data: { id: string }
  }
  const sessionID = session.data.id
  // Baseline: the synthetic status path must work before lifecycle commands.
  await commandResult(sessionID, "omo-status", "", "scheduler")
  // 1. Create the plan; the duplicate create must not produce a second plan.
  await commandResult(sessionID, "omo-plan", planArgs, "lc-cycle")
  try {
    await api(`/api/session/${sessionID}/command`, "post", { name: "omo-plan", text: planArgs })
  } catch {
    // The duplicate create is expected to be rejected; no-duplication is
    // asserted on the observed state below, not on the rejection surfacing.
  }
  const created = (await commandResult(sessionID, "omo-status", "", "lc-cycle")) as {
    plans?: Array<{ id: string }>
  }
  const copies = (created.plans ?? []).filter((plan) => plan.id === "lc-cycle")
  if (copies.length !== 1)
    throw new Error(`Duplicate plan execution: ${copies.length} copies of lc-cycle`)
  const beforeRestart = planOf(created)
  if (beforeRestart?.steps?.map((step) => step.state).join(",") !== "pending,pending")
    throw new Error(`Unexpected pre-cancel states: ${JSON.stringify(beforeRestart?.steps)}`)
  // 2. Cancel the plan; status must show cancellation and no running work.
  const cancelled = (await commandResult(sessionID, "omo-cancel", "lc-cycle", "lc-cycle")) as {
    plans?: unknown
    runs?: unknown[]
    scheduler?: { active?: unknown[]; queued?: unknown[] }
  }
  const cancelledPlan = planOf(cancelled)
  if (cancelledPlan?.steps?.some((step) => step.state === "running"))
    throw new Error("Cancel left running work behind")
  if ((cancelled.runs ?? []).length !== 0) throw new Error("Cancel left unresolved runs")
  // 3. Restart the server; the cancelled state must survive with no resurrection.
  await stopServer()
  await startServer()
  evidence.serverGenerations = 2
  const afterRestart = (await commandResult(sessionID, "omo-status", "", "lc-cycle")) as {
    plans?: Array<{ id: string }>
    runs?: unknown[]
  }
  const revived = planOf(afterRestart)
  if (!revived) throw new Error("Plan state lost across restart")
  if (revived.steps?.some((step) => step.state === "running" || step.state === "verifying"))
    throw new Error(`Restart resurrected work: ${JSON.stringify(revived.steps)}`)
  if ((afterRestart.runs ?? []).length !== 0) throw new Error("Restart left unresolved runs")
  if ((afterRestart.plans ?? []).filter((plan) => plan.id === "lc-cycle").length !== 1)
    throw new Error("Restart duplicated the plan")
  // 4. Resume reconciles without resurrecting cancelled work.
  const resumed = (await commandResult(sessionID, "omo-resume", "lc-cycle", "lc-cycle")) as {
    plans?: Array<{ id: string }>
    runs?: unknown[]
  }
  const reconciled = planOf(resumed)
  if (!reconciled) throw new Error("Plan state lost across resume")
  if (reconciled.steps?.some((step) => step.state === "running" || step.state === "verifying"))
    throw new Error(`Resume resurrected work: ${JSON.stringify(reconciled.steps)}`)
  if ((resumed.runs ?? []).length !== 0) throw new Error("Resume left unresolved runs")
  // 5. Registrations must not duplicate across the restart either.
  const agents = await api("/api/agent")
  const commands = await api("/api/command")
  assertSmokeAgentsRegistered(agents.data ?? [])
  const names = (commands.data ?? [])
    .map((item: { name: string }) => item.name)
    .filter((name: string) => name.startsWith("omo-"))
  if (new Set(names).size !== names.length) throw new Error("Duplicate commands after restart")
  if (!(await Bun.file(join(env.OMO_CONFIG_HOME, "omo.jsonc")).exists()))
    throw new Error("Installed plugin did not create its isolated configuration")
  evidence.omoPaths = { home: env.OMO_HOME, config: env.OMO_CONFIG_HOME }
  evidence.profiles = smokeAgentIDs.length
  evidence.commands = names
  evidence.assertions = [
    "plan created once; duplicate create produced no second plan",
    "cancel left no running steps and no unresolved runs",
    "cancelled plan state survived the restart with no resurrection",
    "no unresolved runs after the restart",
    "single plan copy after the restart",
    "resume reconciled without resurrecting work or leaving runs",
    "all 17 profiles present once without legacy IDs; commands unique after restart",
  ]
  evidence.result = "passed"
  console.log(`Lifecycle smoke passed; evidence: ${artifact}`)
} catch (error) {
  evidence.result = "failed"
  evidence.error = error instanceof Error ? error.message : String(error)
  evidence.serverLogTail = serverLog
  throw error
} finally {
  await stopServer()
  serverLog = ""
  await writeFile(artifact, JSON.stringify(evidence, null, 2))
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
