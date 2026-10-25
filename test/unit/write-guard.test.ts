import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { mountWriteGuard } from "../../src/tools/write-guard"

let tmpDir: string
let guardDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omo-write-guard-"))
  guardDir = join(tmpDir, "project")
  mkdirSync(guardDir, { recursive: true })
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function fakeCtx(directory: string) {
  const beforeHooks: Array<(input: unknown) => void> = []
  return {
    ctx: {
      tool: {
        hook: async (_name: string, callback: (input: unknown) => void) => {
          beforeHooks.push(callback)
          return {
            dispose: async () => {
              const at = beforeHooks.indexOf(callback)
              if (at >= 0) beforeHooks.splice(at, 1)
            },
          }
        },
      },
      location: { directory },
    } as unknown as Plugin.Context,
    beforeHooks,
  }
}

describe("write-guard", () => {
  test("mountWriteGuard registers an execute.before hook", async () => {
    const { ctx, beforeHooks } = fakeCtx(guardDir)
    const dispose = await mountWriteGuard(ctx)
    expect(beforeHooks).toHaveLength(1)
    await dispose()
    expect(beforeHooks).toHaveLength(0)
  })

  test("write to non-existent file passes through", async () => {
    const { ctx, beforeHooks } = fakeCtx(guardDir)
    await mountWriteGuard(ctx)
    const before = beforeHooks[0] as (input: unknown) => void
    const target = join(guardDir, "new.txt")
    // Should not throw
    expect(() =>
      before({
        tool: "write",
        sessionID: "ses_test",
        input: { filePath: target, content: "hello" },
      }),
    ).not.toThrow()
  })

  test("write to existing file without prior read throws", async () => {
    const { ctx, beforeHooks } = fakeCtx(guardDir)
    const target = join(guardDir, "existing.txt")
    writeFileSync(target, "original")
    await mountWriteGuard(ctx)
    const before = beforeHooks[0] as (input: unknown) => void
    expect(() =>
      before({ tool: "write", sessionID: "ses_test", input: { filePath: target, content: "new" } }),
    ).toThrow("File already exists")
  })

  test("write to existing file after read passes", async () => {
    const { ctx, beforeHooks } = fakeCtx(guardDir)
    const target = join(guardDir, "read-then-write.txt")
    writeFileSync(target, "original")
    await mountWriteGuard(ctx)
    const before = beforeHooks[0] as (input: unknown) => void
    // First: read the file
    expect(() =>
      before({ tool: "read", sessionID: "ses_test", input: { filePath: target } }),
    ).not.toThrow()
    // Then: write should pass
    expect(() =>
      before({ tool: "write", sessionID: "ses_test", input: { filePath: target, content: "new" } }),
    ).not.toThrow()
  })

  test("write with overwrite flag passes even without read", async () => {
    const { ctx, beforeHooks } = fakeCtx(guardDir)
    const target = join(guardDir, "overwrite.txt")
    writeFileSync(target, "original")
    await mountWriteGuard(ctx)
    const before = beforeHooks[0] as (input: unknown) => void
    expect(() =>
      before({
        tool: "write",
        sessionID: "ses_test",
        input: { filePath: target, content: "new", overwrite: true },
      }),
    ).not.toThrow()
  })

  test("non-write/read tools pass through", async () => {
    const { ctx, beforeHooks } = fakeCtx(guardDir)
    await mountWriteGuard(ctx)
    const before = beforeHooks[0] as (input: unknown) => void
    expect(() =>
      before({ tool: "bash", sessionID: "ses_test", input: { command: "ls" } }),
    ).not.toThrow()
  })

  test("read without sessionID is a no-op", async () => {
    const { ctx, beforeHooks } = fakeCtx(guardDir)
    const target = join(guardDir, "no-session.txt")
    writeFileSync(target, "content")
    await mountWriteGuard(ctx)
    const before = beforeHooks[0] as (input: unknown) => void
    expect(() =>
      before({ tool: "read", sessionID: undefined, input: { filePath: target } }),
    ).not.toThrow()
  })

  test("paths outside project root pass through", async () => {
    const { ctx, beforeHooks } = fakeCtx(guardDir)
    await mountWriteGuard(ctx)
    const before = beforeHooks[0] as (input: unknown) => void
    expect(() =>
      before({
        tool: "write",
        sessionID: "ses_test",
        input: { filePath: "/etc/passwd", content: "x" },
      }),
    ).not.toThrow()
  })

  test("different sessions cannot write files another session read", async () => {
    const { ctx, beforeHooks } = fakeCtx(guardDir)
    const target = join(guardDir, "session-isolation.txt")
    writeFileSync(target, "original")
    await mountWriteGuard(ctx)
    const before = beforeHooks[0] as (input: unknown) => void
    // Session A reads
    expect(() =>
      before({ tool: "read", sessionID: "ses_a", input: { filePath: target } }),
    ).not.toThrow()
    // Session B tries to write — should fail
    expect(() =>
      before({ tool: "write", sessionID: "ses_b", input: { filePath: target, content: "new" } }),
    ).toThrow("File already exists")
  })
})
