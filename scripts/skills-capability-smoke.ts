import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { runSmokeCommand } from "./smoke-package"

const SKILLS_PACKAGE = "@shtora/skills@0.1.0"
const SANDBOX_ROOT = join(tmpdir(), "omo", "skills-capability-smoke")
const EVIDENCE_ROOT = join(process.env.LOCALAPPDATA ?? tmpdir(), "Temp", "opencode")
const CALL_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 300_000
const PREVIEW_SKILL_ID = "anthropics/skills/mcp-builder"
const PREVIEW_SKILL_PATH = "skills/mcp-builder"
const EXPECTED_TOOLS = [
  "search_skills",
  "get_skill",
  "get_skill_audits",
  "get_top_skills",
  "get_official_skills",
  "list_installed_skills",
  "check_skill_updates",
  "install_skill",
  "update_skill",
  "remove_skill",
] as const

type CleanEnv = NodeJS.ProcessEnv & { PATH: string }
type JsonRpcMessage = { id?: unknown; result?: unknown; error?: { message?: string } }
type ToolResult = { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
type PendingCall = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function cleanEnvironment(): CleanEnv {
  const variable = { ...process.env }
  for (const name of Object.keys(variable)) {
    if (name.startsWith("OPENCODE_") || name.startsWith("OMO_")) delete variable[name]
  }
  delete variable.GITHUB_API_KEY
  delete variable.CONTEXT7_API_KEY
  delete variable.VERCEL_OIDC_TOKEN
  delete variable.SKILLS_PROJECT_ROOT
  delete variable.SKILLS_ALLOW_MUTATIONS
  const path = variable.Path === undefined ? variable.PATH : variable.Path
  if (path === undefined) throw new Error("PATH must exist for the skills capability smoke")
  return { ...variable, PATH: path }
}

class StdioJsonRpcClient {
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private buffer = ""

  constructor(private readonly server: ReturnType<typeof spawn>) {
    this.server.stdout?.setEncoding("utf8")
    this.server.stdout?.on("data", (chunk: string) => this.receive(chunk))
    this.server.on("exit", (code) => this.failPending(`skills MCP exited with code ${code}`))
    this.server.on("error", (error) => this.failPending(`skills MCP failed: ${error.message}`))
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ""
    for (const line of lines.filter(Boolean)) this.handleLine(line)
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }
    if (typeof message.id !== "number") return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message ?? "skills MCP call failed"))
    else entry.resolve(message.result)
  }

  private failPending(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.pending.clear()
  }

  notify(method: string): void {
    this.server.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`)
  }

  call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`skills MCP call ${method} timed out`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.server.stdin?.write(`${payload}\n`, (error) => {
        if (!error) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error("failed to write to the skills MCP"))
      })
    })
  }
}

function toolText(result: unknown): { text: string; isError: boolean } {
  const value = result as ToolResult
  const text = (value.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
  return { text, isError: value.isError === true }
}

async function snapshotTree(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>()
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`
      const path = join(directory, entry.name)
      const stats = await stat(path)
      if (entry.isDirectory()) await walk(path, `${relative}/`)
      else files.set(relative, stats.size)
    }
  }
  await walk(root, "")
  return files
}

function equalTrees(before: Map<string, number>, after: Map<string, number>): boolean {
  if (before.size !== after.size) return false
  for (const [path, size] of before) if (after.get(path) !== size) return false
  return true
}

async function expectPermissionRefusal(
  client: StdioJsonRpcClient,
  name: string,
  args: unknown,
): Promise<void> {
  try {
    const { text, isError } = toolText(await client.call("tools/call", { name, arguments: args }))
    if (!isError || !text.includes("[PERMISSION_DENIED]"))
      throw new Error(`${name} unexpectedly succeeded while mutations are disabled`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes("PERMISSION_DENIED")) throw error
  }
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

let evidenceFile = ""

async function main(): Promise<void> {
  const parentBaseline = process.env.SKILLS_ALLOW_MUTATIONS
  await mkdir(SANDBOX_ROOT, { recursive: true })
  const sandbox = await mkdtemp(join(SANDBOX_ROOT, "run-"))
  let server: ReturnType<typeof spawn> | undefined
  try {
    const cleaned = cleanEnvironment()
    const project = join(sandbox, "project")
    const fixtureSkillDirectory = join(project, ".agents", "skills", "fixture-skill")
    await mkdir(fixtureSkillDirectory, { recursive: true })
    await writeFile(
      join(fixtureSkillDirectory, "SKILL.md"),
      "---\r\nname: fixture-skill\r\ndescription: Local fixture used by the OmO skills capability smoke.\r\n---\r\n\r\n# Fixture skill\r\n",
    )
    const treeBefore = await snapshotTree(project)

    await runSmokeCommand(["bun", "add", SKILLS_PACKAGE], {
      cwd: sandbox,
      env: cleaned,
      timeoutMs: INSTALL_TIMEOUT_MS,
      label: `bun add ${SKILLS_PACKAGE}`,
    })
    const serverEntry = join(sandbox, "node_modules", "@shtora", "skills", "dist", "index.js")
    const inheritedEnv = { ...cleaned, SKILLS_ALLOW_MUTATIONS: "true" }
    const serverEnv = {
      ...inheritedEnv,
      SKILLS_ALLOW_MUTATIONS: "false",
      SKILLS_PROJECT_ROOT: project,
    }
    server = spawn(process.execPath, [serverEntry], {
      cwd: sandbox,
      env: serverEnv,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const client = new StdioJsonRpcClient(server)
    await client.call("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "omo-skills-capability-smoke", version: "0.1.0" },
    })
    client.notify("notifications/initialized")
    const listed = (await client.call("tools/list", {})) as { tools?: Array<{ name?: unknown }> }
    const names = (listed.tools ?? []).map((tool) => String(tool.name)).sort()
    const expected = [...EXPECTED_TOOLS].sort()
    if (JSON.stringify(names) !== JSON.stringify(expected))
      throw new Error(`unexpected skills tool catalog: ${JSON.stringify(names)}`)

    const inventoryText = toolText(
      await client.call("tools/call", {
        name: "list_installed_skills",
        arguments: { scope: "project" },
      }),
    ).text
    const inventory = JSON.parse(inventoryText) as {
      skills?: Array<{ name?: string; managed?: boolean }>
    }
    const fixtureEntry = (inventory.skills ?? []).find((skill) => skill.name === "fixture-skill")
    if (!fixtureEntry) throw new Error("list_installed_skills did not report the fixture skill")
    if (fixtureEntry.managed === true)
      throw new Error("list_installed_skills reported the untracked fixture skill as managed")

    await expectPermissionRefusal(client, "install_skill", {
      id: "owner/repo/skill",
      scope: "project",
      dry_run: false,
      confirm: true,
    })
    await expectPermissionRefusal(client, "remove_skill", {
      name: "fixture-skill",
      scope: "project",
      dry_run: false,
      confirm: true,
    })
    if (existsSync(join(project, "skills-lock.json")))
      throw new Error("the skills MCP created a lock file while mutations are disabled")
    if (!equalTrees(treeBefore, await snapshotTree(project)))
      throw new Error("the skills MCP mutated the project while mutations are disabled")

    const previewProbe: Record<string, unknown> = { attempted: true }
    try {
      const preview = toolText(
        await client.call("tools/call", {
          name: "install_skill",
          arguments: {
            id: PREVIEW_SKILL_ID,
            path: PREVIEW_SKILL_PATH,
            scope: "project",
            dry_run: true,
            confirm: false,
          },
        }),
      )
      const payload = JSON.parse(preview.text) as Record<string, unknown>
      previewProbe.ok = !preview.isError
      previewProbe.tokenIssued =
        typeof payload.confirmation_token === "string" && payload.confirmation_token.length > 0
    } catch (error) {
      previewProbe.ok = false
      previewProbe.reason = (error instanceof Error ? error.message : "preview failed").split(
        "\n",
      )[0]
    }
    previewProbe.diskUnchanged = equalTrees(treeBefore, await snapshotTree(project))

    if (process.env.SKILLS_ALLOW_MUTATIONS !== parentBaseline)
      throw new Error("the smoke mutated the parent process environment")

    evidenceFile = join(EVIDENCE_ROOT, `shtora-omo-skills-capability-${process.pid}.json`)
    await mkdir(EVIDENCE_ROOT, { recursive: true })
    await writeFile(
      evidenceFile,
      `${JSON.stringify(
        {
          result: "passed",
          skillsPackage: SKILLS_PACKAGE,
          tools: names,
          fixtureSkillListed: true,
          fixtureSkillTracked: false,
          mutationsDisabledRefusals: true,
          projectTreeUnchanged: true,
          skillsLockAbsent: true,
          parentEnvironmentUnmutated: true,
          previewProbe,
        },
        null,
        2,
      )}\n`,
    )
    console.log(`skills capability smoke passed; evidence ${evidenceFile}`)
  } finally {
    if (server) await stopServer(server)
    await rm(sandbox, { recursive: true, force: true })
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
