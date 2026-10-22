import { expect, test } from "bun:test"

// Tripwire test (not a behavior test): pins the public plugin surface of the
// installed SDK (@opencode/plugin 2.0.32) on which three documented blockers
// rest — ask creation, global session listing, and host-tool invocation for
// LSP apply. If a future SDK upgrade changes any of these declarations, the
// failing assertion tells the maintainer exactly which blocker to re-test.
const sdkRoot = new URL("../../node_modules/@opencode/plugin/", import.meta.url)
const promiseDir = new URL("dist/promise/", sdkRoot)

async function declaration(file: string): Promise<string> {
  return Bun.file(new URL(file, promiseDir)).text()
}

test("pinned SDK baseline is @opencode/plugin 2.0.32", async () => {
  const pkg = (await Bun.file(new URL("package.json", sdkRoot)).json()) as {
    version: string
  }
  expect(pkg.version).toBe("2.0.32")
})

test("PermissionDomain exposes no ask-creation method (ask stays fail-closed)", async () => {
  const text = await declaration("permission.d.ts")
  const pick = text.match(/Pick<PermissionApi,([^>]+)>/)
  if (!pick?.[1]) throw new Error("PermissionDomain Pick not found")
  expect(pick[1].replace(/\s+/g, " ").trim()).toBe('"list" | "get" | "reply"')
})

test("SessionDomain exposes no list method (global listing stays N/A-V2)", async () => {
  const text = await declaration("session.d.ts")
  const pick = text.match(/Pick<SessionApi,([^>]+)>/)
  if (!pick?.[1]) throw new Error("SessionDomain Pick not found")
  const members = pick[1]
  expect(members).toContain('"context"')
  expect(members).not.toContain('"list"')
})

test("ToolDomain exposes no host-tool invocation (LSP apply stays proposal-only)", async () => {
  const text = await declaration("tool.d.ts")
  const block = text.match(/export interface ToolDomain \{([\s\S]*?)\n\}/)
  if (!block?.[1]) throw new Error("ToolDomain block not found")
  const methods = [...block[1].matchAll(/^ {4}readonly (\w+)\s*:/gm)]
    .map((match) => match[1])
    .sort()
  expect(methods).toEqual(["hook", "list", "reload", "transform"])
})
