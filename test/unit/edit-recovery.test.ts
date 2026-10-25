import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import {
  EDIT_ERROR_PATTERNS,
  EDIT_ERROR_REMINDER,
  mountEditRecovery,
} from "../../src/tools/edit-recovery"

function fakeCtx() {
  const hooks: Array<(input: unknown) => void> = []
  return {
    ctx: {
      tool: {
        hook: async (_name: string, callback: (input: unknown) => void) => {
          hooks.push(callback)
          return {
            dispose: async () => {
              const at = hooks.indexOf(callback)
              if (at >= 0) hooks.splice(at, 1)
            },
          }
        },
      },
    } as unknown as Plugin.Context,
    hooks,
  }
}

describe("edit-recovery", () => {
  test("EDIT_ERROR_PATTERNS covers the three known Edit failure modes", () => {
    expect(EDIT_ERROR_PATTERNS).toEqual([
      "oldString and newString must be different",
      "oldString not found",
      "oldString found multiple times",
    ])
  })

  test("EDIT_ERROR_REMINDER is non-empty and actionable", () => {
    expect(EDIT_ERROR_REMINDER.length).toBeGreaterThan(0)
    expect(EDIT_ERROR_REMINDER).toContain("READ the file immediately")
  })

  test("mountEditRecovery registers an execute.after hook", async () => {
    const { ctx, hooks } = fakeCtx()
    await mountEditRecovery(ctx)
    expect(hooks).toHaveLength(1)
  })

  test("hook is a no-op for non-edit tools", async () => {
    const { ctx, hooks } = fakeCtx()
    await mountEditRecovery(ctx)
    const after = hooks[0] as (input: unknown) => void
    const result = { output: "some write output" }
    after({ tool: "write", status: "completed", result })
    expect(result.output).toBe("some write output")
  })

  test("hook is a no-op when edit output has no error pattern", async () => {
    const { ctx, hooks } = fakeCtx()
    await mountEditRecovery(ctx)
    const after = hooks[0] as (input: unknown) => void
    const result = { output: "file updated successfully" }
    after({ tool: "edit", status: "completed", result })
    expect(result.output).toBe("file updated successfully")
  })

  test("hook injects reminder when edit output contains 'oldString not found'", async () => {
    const { ctx, hooks } = fakeCtx()
    await mountEditRecovery(ctx)
    const after = hooks[0] as (input: unknown) => void
    const result = { output: "Error: oldString not found in file" }
    after({ tool: "edit", status: "completed", result })
    expect(result.output).toContain("oldString not found")
    expect(result.output).toContain(EDIT_ERROR_REMINDER)
  })

  test("hook injects reminder when edit output contains 'oldString found multiple times'", async () => {
    const { ctx, hooks } = fakeCtx()
    await mountEditRecovery(ctx)
    const after = hooks[0] as (input: unknown) => void
    const result = { output: "Error: oldString found multiple times in file" }
    after({ tool: "edit", status: "completed", result })
    expect(result.output).toContain(EDIT_ERROR_REMINDER)
  })

  test("hook injects reminder when edit output contains 'oldString and newString must be different'", async () => {
    const { ctx, hooks } = fakeCtx()
    await mountEditRecovery(ctx)
    const after = hooks[0] as (input: unknown) => void
    const result = { output: "Error: oldString and newString must be different" }
    after({ tool: "edit", status: "completed", result })
    expect(result.output).toContain(EDIT_ERROR_REMINDER)
  })

  test("hook is case-insensitive on pattern matching", async () => {
    const { ctx, hooks } = fakeCtx()
    await mountEditRecovery(ctx)
    const after = hooks[0] as (input: unknown) => void
    const result = { output: "OLDSTRING NOT FOUND" }
    after({ tool: "edit", status: "completed", result })
    expect(result.output).toContain(EDIT_ERROR_REMINDER)
  })

  test("dispose removes the hook", async () => {
    const { ctx, hooks } = fakeCtx()
    const dispose = await mountEditRecovery(ctx)
    expect(hooks).toHaveLength(1)
    await dispose()
    expect(hooks).toHaveLength(0)
  })
})
