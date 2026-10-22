import { describe, expect, test } from "bun:test"
import { resolveOptions } from "../../src/config/resolve"
import { DEFAULT_PACKAGE_MANAGER, packageRunner } from "../../src/config/runtime"
import { parseOptions } from "../../src/config/schema"

describe("runtime configuration", () => {
  test("defaults the package manager to bun", () => {
    const resolved = resolveOptions(parseOptions({ schemaVersion: 1 }))
    expect(resolved.runtime.packageManager).toBe(DEFAULT_PACKAGE_MANAGER)
    expect(DEFAULT_PACKAGE_MANAGER).toBe("bun")
  })

  test("accepts each known package manager verbatim", () => {
    for (const packageManager of ["npm", "bun", "yarn", "pnpm"] as const) {
      const resolved = resolveOptions(
        parseOptions({ schemaVersion: 1, runtime: { packageManager } }),
      )
      expect(resolved.runtime.packageManager).toBe(packageManager)
    }
  })

  test("rejects an unknown package manager", () => {
    expect(() => parseOptions({ schemaVersion: 1, runtime: { packageManager: "deno" } })).toThrow(
      "runtime.packageManager",
    )
  })

  test("rejects a non-string package manager", () => {
    expect(() => parseOptions({ schemaVersion: 1, runtime: { packageManager: 1 } })).toThrow(
      "runtime.packageManager",
    )
  })

  test("rejects an unknown runtime key", () => {
    expect(() => parseOptions({ schemaVersion: 1, runtime: { runner: "npx" } })).toThrow(
      "runtime.runner",
    )
  })

  test("rejects a non-object runtime section", () => {
    expect(() => parseOptions({ schemaVersion: 1, runtime: "npx" })).toThrow("runtime")
  })
})

describe("package runner mapping", () => {
  test("maps each manager to its one-off runner command", () => {
    expect(packageRunner("npm")).toEqual({ command: "npx", args: [] })
    expect(packageRunner("bun")).toEqual({ command: "bunx", args: [] })
    expect(packageRunner("yarn")).toEqual({ command: "yarn", args: ["dlx"] })
    expect(packageRunner("pnpm")).toEqual({ command: "pnpm", args: ["dlx"] })
  })
})
