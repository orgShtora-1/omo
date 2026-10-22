import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { packSmokeTarball, runSmokeCommand } from "./smoke-package"

type McpEntry = { name: string; status: { status: string; error?: string } }
type CleanEnv = NodeJS.ProcessEnv & { PATH: string }

const SANDBOX_ROOT = join(tmpdir(), "omo", "mcp-package-smoke")
const EVIDENCE_ROOT = join(process.env.LOCALAPPDATA ?? tmpdir(), "Temp", "opencode")
const BUILTIN_MCP_NAMES = ["github", "context7", "skills"] as const

function cleanEnvironment(): CleanEnv {
  const variable = { ...process.env }
  for (const name of Object.keys(variable)) {
    if (name.startsWith("OPENCODE_") || name.startsWith("OMO_")) delete variable[name]
  }
  delete variable.GITHUB_API_KEY
  delete variable.CONTEXT7_API_KEY
  delete variable.VERCEL_OIDC_TOKEN
  const path = variable.Path === undefined ? variable.PATH : variable.Path
  if (path === undefined) throw new Error("PATH must exist for the MCP package smoke")
  return { ...(variable as NodeJS.ProcessEnv), PATH: path }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function sanitiseEntries(value: unknown): Array<{ name: string; status: string; error?: string }> {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    const server = entry as McpEntry
    return {
      name: String(server.name),
      status: String(server.status.status),
      ...(server.status.error ? { error: server.status.error } : {}),
    }
  })
}

function startRemoteFixture() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST")
        return Response.json({ error: "unsupported request" }, { status: 405 })
      let message: unknown
      try {
        message = await request.json()
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        return Response.json({ error: "invalid JSON-RPC request" }, { status: 400 })
      }
      if (!message || typeof message !== "object")
        return Response.json({ error: "unsupported request" }, { status: 405 })
      const rpc = message as { id?: unknown; method?: string; params?: Record<string, unknown> }
      if (rpc.id === undefined) return new Response(null, { status: 202 })
      if (rpc.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture-remote", version: "1.0.0" },
          },
        })
      }
      if (rpc.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { tools: [{ name: "probe_ping", inputSchema: { type: "object" } }] },
        })
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {} })
    },
  })
}

async function writeLocalFixture(path: string, expectedProjectRoot: string): Promise<void> {
  const source = `let buffer = ""
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n")
}
function respond(message) {
  if (message.id === undefined) return
  if (message.method === "initialize") {
    if (process.env.VERCEL_OIDC_TOKEN !== "fixture-dotenv-token" ||
        process.env.OMO_TEST_MCP_DOTENV_ONLY !== undefined ||
        process.env.SKILLS_ALLOW_MUTATIONS !== "false" ||
        process.env.SKILLS_PROJECT_ROOT !== ${JSON.stringify(expectedProjectRoot)}) {
      send({ jsonrpc: "2.0", id: message.id,
        error: { code: -32000, message: "MCP environment isolation check failed" } })
      return
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-stdio", version: "1.0.0" },
      },
    })
    return
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [{ name: "probe_ping", inputSchema: { type: "object" } }] },
    })
    return
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} })
}
process.stdin.on("data", (chunk) => {
  buffer += String(chunk)
  const lines = buffer.split(/\\r?\\n/)
  buffer = lines.pop() ?? ""
  for (const line of lines.filter(Boolean)) respond(JSON.parse(line))
})
process.stdin.on("end", () => process.exit(0))
`
  await writeFile(path, source)
}

async function callApi(
  serverURL: string,
  directory: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const separator = path.includes("?") ? "&" : "?"
  const args = [
    "api",
    "--server",
    serverURL,
    method,
    `${path}${separator}location[directory]=${encodeURIComponent(directory)}`,
  ]
  if (body !== undefined) args.push("--data", JSON.stringify(body))
  const stdout = await runSmokeCommand(["opencode", ...args], {
    cwd: currentDirectory,
    env: currentEnvironment,
    timeoutMs: 30_000,
    label: `opencode api ${method} ${path}`,
  })
  return stdout ? (JSON.parse(stdout) as unknown) : undefined
}

async function mcpEntries(serverURL: string, directory: string): Promise<McpEntry[]> {
  const response = await callApi(serverURL, directory, "get", "/api/mcp")
  if (!response || typeof response !== "object" || !("data" in response)) return []
  return Array.isArray(response.data) ? (response.data as McpEntry[]) : []
}

async function activate(serverURL: string, directory: string): Promise<void> {
  await callApi(serverURL, directory, "post", "/api/location/reload")
  await callApi(serverURL, directory, "post", "/api/session", { title: `mcp smoke ${Date.now()}` })
}

async function waitForMcp(
  serverURL: string,
  directory: string,
  predicate: (entries: McpEntry[]) => boolean,
): Promise<McpEntry[]> {
  const started = Date.now()
  let entries = await mcpEntries(serverURL, directory)
  while (!predicate(entries) && Date.now() - started < 60_000) {
    await sleep(1_000)
    entries = await mcpEntries(serverURL, directory)
  }
  if (!predicate(entries))
    throw new Error(`MCP smoke timed out: ${JSON.stringify(sanitiseEntries(entries))}`)
  return entries
}

async function locateServer(
  env: NodeJS.ProcessEnv,
  directory: string,
): Promise<{ serverURL: string; process: ReturnType<typeof spawn> }> {
  return await new Promise((resolve, reject) => {
    const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let buffer = ""
    const timeout = setTimeout(
      () => reject(new Error(`opencode serve did not publish a URL: ${buffer}`)),
      30_000,
    )
    const capture = (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = buffer.match(/https?:\/\/127\.0\.0\.1:\d+/)
      if (!match) return
      clearTimeout(timeout)
      resolve({ serverURL: match[0], process: server })
    }
    server.stdout?.on("data", capture)
    server.stderr?.on("data", capture)
    server.once("exit", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`opencode serve exited ${code}: ${buffer}`))
    })
  })
}

async function stopServer(server: ReturnType<typeof spawn>): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null || !server.pid) return
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
        stdio: "ignore",
      })
      killer.once("close", () => resolve())
      killer.once("error", () => resolve())
    })
    return
  }
  server.kill("SIGTERM")
}

let currentEnvironment: NodeJS.ProcessEnv = {}
let currentDirectory = process.cwd()
let evidenceFile = ""

async function main(): Promise<void> {
  await mkdir(SANDBOX_ROOT, { recursive: true })
  const path = await mkdtemp(join(SANDBOX_ROOT, "run-"))
  const server = { process: undefined as ReturnType<typeof spawn> | undefined }
  let fixture: ReturnType<typeof startRemoteFixture> | undefined
  try {
    const isolated = cleanEnvironment()
    const home = join(path, "home")
    const project = join(path, "project")
    await mkdir(join(project, "local-shares"), { recursive: true })
    currentDirectory = project
    for (const directory of ["config", "data", "state", "cache"])
      await mkdir(join(home, directory), { recursive: true })
    const omoConfigHome = join(home, "config", "opencode")
    await mkdir(omoConfigHome, { recursive: true })
    Object.assign(isolated, {
      HOME: home,
      USERPROFILE: home,
      OMO_HOME: join(project, "local-shares", "omo"),
      OMO_CONFIG_HOME: omoConfigHome,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
      OPENCODE_DB: join(path, "opencode.db"),
      OPENCODE_CONFIG_PROJECT_DISABLE: "true",
      OPENCODE_CONFIG: join(project, "opencode.jsonc"),
      OPENCODE_SERVER_PASSWORD: `mcp-${randomBytes(12).toString("hex")}`,
    })
    currentEnvironment = isolated

    const hostConfig = join(project, "opencode.jsonc")
    const hostBefore = JSON.stringify(
      {
        plugins: [
          {
            package: join(project, "node_modules", "@shtora", "omo"),
            options: { schemaVersion: 1 },
          },
        ],
      },
      null,
      2,
    )
    fixture = startRemoteFixture()
    const remoteURL = `http://127.0.0.1:${fixture.port}/mcp`
    const fixturePath = join(path, "fixture-mcp.ts")
    await writeLocalFixture(fixturePath, project)
    const omoConfig = {
      schemaVersion: 1,
      mcp: {
        servers: {
          skills: {
            command: [process.execPath, fixturePath],
            protocol: "legacy",
            environment: { VERCEL_OIDC_TOKEN: "{env:VERCEL_OIDC_TOKEN}" },
          },
          github: { url: remoteURL, oauth: false, headers: {} },
          context7: { url: remoteURL, oauth: false, headers: {} },
          vercel: { disabled: true },
          cloudflare: { disabled: true },
        },
      },
    }
    await writeFile(join(omoConfigHome, "omo.jsonc"), JSON.stringify(omoConfig, null, 2))
    await writeFile(
      join(omoConfigHome, ".env"),
      "VERCEL_OIDC_TOKEN=fixture-dotenv-token\nOMO_TEST_MCP_DOTENV_ONLY=fixture-private\n",
    )

    const artifactRoot = join(path, "artifacts")
    await mkdir(artifactRoot, { recursive: true })
    const tarball = await packSmokeTarball(artifactRoot, isolated)
    const tarballPath = join(artifactRoot, tarball.filename).replaceAll("\\", "/")
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { "@shtora/omo": `file:${tarballPath}` },
      }),
    )
    await runSmokeCommand(["bun", "install", "--ignore-scripts"], {
      env: isolated,
      cwd: project,
      timeoutMs: 300_000,
      label: "bun install",
    })
    await writeFile(hostConfig, hostBefore)
    const hostBytes = await readFile(hostConfig, "utf8")

    const located = await locateServer(isolated, project)
    server.process = located.process
    await activate(located.serverURL, project)
    const expected = (entries: McpEntry[]) =>
      BUILTIN_MCP_NAMES.every((name) =>
        entries.some((entry) => entry.name === name && entry.status.status === "connected"),
      )
    const active = await waitForMcp(located.serverURL, project, expected)
    if (active.some((entry) => entry.name === "vercel" || entry.name === "cloudflare"))
      throw new Error("disabled optional presets appeared in the host registry")
    await activate(located.serverURL, project)
    const reloaded = await waitForMcp(located.serverURL, project, expected)
    if (new Set(reloaded.map((entry) => entry.name)).size !== reloaded.length)
      throw new Error("MCP registrations duplicated across reload")
    if ((await readFile(hostConfig, "utf8")) !== hostBytes)
      throw new Error("plugin modified the host configuration during MCP registration")
    if (
      (await readFile(join(omoConfigHome, "omo.jsonc"), "utf8")) !==
      JSON.stringify(omoConfig, null, 2)
    )
      throw new Error("plugin modified omo.jsonc during MCP environment resolution")

    await writeFile(hostConfig, JSON.stringify({ plugins: [] }, null, 2))
    await activate(located.serverURL, project)
    await waitForMcp(located.serverURL, project, (entries) => entries.length === 0)

    const hostAfter = await readFile(hostConfig, "utf8")
    const parsed = JSON.parse(hostAfter) as { mcp?: unknown }
    if ("mcp" in parsed) throw new Error("host configuration unexpectedly gained an mcp section")
    evidenceFile = join(EVIDENCE_ROOT, `shtora-omo-mcp-smoke-${process.pid}.json`)
    await mkdir(EVIDENCE_ROOT, { recursive: true })
    await writeFile(
      evidenceFile,
      `${JSON.stringify(
        {
          result: "passed",
          hostVersion: await runSmokeCommand(["opencode", "--version"], {
            cwd: project,
            env: isolated,
            label: "opencode --version",
          }),
          pluginRegisteredMcp: sanitiseEntries(active),
          mcpAfterUnload: sanitiseEntries(await mcpEntries(located.serverURL, project)),
          hostConfigUnchanged: hostAfter === JSON.stringify({ plugins: [] }, null, 2),
          noHostMcpSection: true,
          skillsReceivedConfigDotenvToken: true,
          unreferencedDotenvVariableNotForwarded: true,
          skillsMutationsDisabledDefault: true,
          skillsProjectRootConfigured: true,
          omoConfigUnchanged: true,
          expectedHostBytesBeforeActivation: hostBytes.length > 0,
        },
        null,
        2,
      )}\n`,
    )
    console.log(`mcp package smoke passed; evidence ${evidenceFile}`)
  } finally {
    if (server.process) await stopServer(server.process)
    fixture?.stop(true)
    await rm(path, { recursive: true, force: true })
  }
}

await main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
