import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const live = process.env.OMO_LIVE === "1" ? test : test.skip
const fixture = fileURLToPath(new URL("../fixtures/agents-probe-project/", import.meta.url))

live(
  "host enforces read-only shell deny even with an adversarial prompt",
  async () => {
    // A private host isolates the probe wrapper from globally installed product profiles.
    const configHome = await mkdtemp(join(tmpdir(), "omo-permission-config-"))
    const cwd = join(configHome, "project")
    await mkdir(cwd)
    await copyFile(join(fixture, "opencode.jsonc"), join(cwd, "opencode.jsonc"))
    const run = Bun.spawn(
      [
        "opencode",
        "run",
        "--standalone",
        "--agent",
        "explore",
        "--format",
        "json",
        ...(process.env.OMO_LIVE_MODEL ? ["--model", process.env.OMO_LIVE_MODEL] : []),
        "Execute your single native shell permission probe and return exact host result.",
      ],
      { cwd, env: { ...process.env, XDG_CONFIG_HOME: configHome }, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ])
    await rm(configHome, { recursive: true, force: true })
    expect(exit, `${stderr}\n${stdout}`).toBe(0)
    const events = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
    const shellCalls = events.filter(
      (event) => event.type === "tool_use" && event.part.tool === "shell",
    )
    expect(shellCalls, stdout).toHaveLength(1)
    expect(shellCalls[0].part.state.status).toBe("error")
    expect(shellCalls[0].part.state.input.command).toBe("echo OMO-PERMISSION-PROBE")
    expect(shellCalls[0].part.state.error).toContain(
      "omo consultation profiles deny shell and edits",
    )
  },
  300_000,
)

live(
  "host permits shell for write profiles under project allow",
  async () => {
    const configHome = await mkdtemp(join(tmpdir(), "omo-permission-config-"))
    const cwd = join(configHome, "project")
    await mkdir(cwd)
    await copyFile(join(fixture, "opencode.jsonc"), join(cwd, "opencode.jsonc"))
    const run = Bun.spawn(
      [
        "opencode",
        "run",
        "--standalone",
        "--agent",
        "executor",
        "--format",
        "json",
        ...(process.env.OMO_LIVE_MODEL ? ["--model", process.env.OMO_LIVE_MODEL] : []),
        "Execute exactly this native shell command and nothing else: echo OMO-ALLOW-PROBE. Return the host result verbatim.",
      ],
      { cwd, env: { ...process.env, XDG_CONFIG_HOME: configHome }, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ])
    await rm(configHome, { recursive: true, force: true })
    expect(exit, `${stderr}\n${stdout}`).toBe(0)
    const events = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
    const shellCalls = events.filter(
      (event) => event.type === "tool_use" && event.part.tool === "shell",
    )
    expect(shellCalls, stdout).toHaveLength(1)
    expect(shellCalls[0].part.state.input.command).toBe("echo OMO-ALLOW-PROBE")
    expect(shellCalls[0].part.state.status).toBe("completed")
    expect(JSON.stringify(shellCalls[0].part.state.output)).toContain("OMO-ALLOW-PROBE")
  },
  300_000,
)
