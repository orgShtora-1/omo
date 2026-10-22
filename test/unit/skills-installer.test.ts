import { describe, expect, test } from "bun:test"
import { buildInstallArgs, installSkill } from "../../src/skills/installer.js"

const ok = { exit: 0, stdout: "", stderr: "", truncated: false }

describe("skills installer", () => {
  test("builds the skills CLI add args", () => {
    expect(buildInstallArgs("obra/superpowers", "tdd")).toEqual([
      "skills",
      "add",
      "obra/superpowers",
      "--skill",
      "tdd",
      "-y",
    ])
  })

  test("runs the configured package manager runner (npm gets a non-interactive -y)", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    await installSkill({
      source: "obra/superpowers",
      slug: "tdd",
      cwd: "/tmp",
      packageManager: "npm",
      run: async (command, args) => {
        calls.push({ command, args })
        return ok
      },
    })
    expect(calls).toEqual([
      {
        command: "npx",
        args: ["-y", "skills", "add", "obra/superpowers", "--skill", "tdd", "-y"],
      },
    ])
  })

  test("prefixes the runner subcommand for yarn", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    await installSkill({
      source: "obra/superpowers",
      slug: "tdd",
      cwd: "/tmp",
      packageManager: "yarn",
      run: async (command, args) => {
        calls.push({ command, args })
        return ok
      },
    })
    expect(calls).toEqual([
      {
        command: "yarn",
        args: ["dlx", "skills", "add", "obra/superpowers", "--skill", "tdd", "-y"],
      },
    ])
  })

  test("defaults to bunx when no package manager is given", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    await installSkill({
      source: "obra/superpowers",
      slug: "tdd",
      cwd: "/tmp",
      run: async (command, args) => {
        calls.push({ command, args })
        return ok
      },
    })
    expect(calls[0]?.command).toBe("bunx")
  })

  test("exit 0 maps to installed", async () => {
    await expect(
      installSkill({ source: "obra/superpowers", slug: "tdd", cwd: "/tmp", run: async () => ok }),
    ).resolves.toBe("installed")
  })

  test("non-zero exit maps to install-failed", async () => {
    await expect(
      installSkill({
        source: "obra/superpowers",
        slug: "tdd",
        cwd: "/tmp",
        run: async () => ({ ...ok, exit: 1, stderr: "boom" }),
      }),
    ).resolves.toBe("install-failed")
  })

  test("throwing runner maps to install-failed without throwing", async () => {
    await expect(
      installSkill({
        source: "obra/superpowers",
        slug: "tdd",
        cwd: "/tmp",
        run: async () => {
          throw new Error("spawn boom")
        },
      }),
    ).resolves.toBe("install-failed")
  })
})
