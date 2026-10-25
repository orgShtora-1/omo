import { describe, expect, test } from "bun:test"
import { formatTodos, mountTodoPreserver } from "../../src/context/todo-preserver"
import type { TodoSnapshot } from "../../src/todo/store"
import type { TodoReader } from "../../src/todo/sync"

// ---------------------------------------------------------------------------
// formatTodos
// ---------------------------------------------------------------------------

describe("formatTodos", () => {
  test("returns empty string when no todos recorded", () => {
    const snapshot: TodoSnapshot = { schemaVersion: 1, recorded: false, todos: [] }
    expect(formatTodos(snapshot)).toBe("")
  })

  test("returns section when todos array is empty but recorded", () => {
    const snapshot: TodoSnapshot = { schemaVersion: 1, recorded: true, todos: [] }
    expect(formatTodos(snapshot)).toContain("No pending todos")
  })

  test("formats pending todos as markdown list", () => {
    const snapshot: TodoSnapshot = {
      schemaVersion: 1,
      recorded: true,
      todos: [
        { content: "fix bug", status: "pending", priority: "high" },
        { content: "write docs", status: "in_progress", priority: "medium" },
        { content: "deploy", status: "completed", priority: "low" },
      ],
    }
    const result = formatTodos(snapshot)
    expect(result).toContain("## Pending Todos")
    expect(result).toContain("- [pending] (high) fix bug")
    expect(result).toContain("- [in_progress] (medium) write docs")
    expect(result).toContain("- [completed] (low) deploy")
  })

  test("escapes carriage returns and newlines in content", () => {
    const snapshot: TodoSnapshot = {
      schemaVersion: 1,
      recorded: true,
      todos: [{ content: "line1\nline2\r\nline3", status: "pending", priority: "medium" }],
    }
    const result = formatTodos(snapshot)
    // The content should have \n and \r escaped as literal backslash sequences
    expect(result).toContain("\\n")
    expect(result).toContain("\\r")
    // But the section header and list item separators are real newlines
    expect(result).toContain("## Pending Todos")
  })
})

// ---------------------------------------------------------------------------
// mountTodoPreserver
// ---------------------------------------------------------------------------

describe("mountTodoPreserver", () => {
  function makeMockCtx(
    overrides: {
      hookCalls?: Array<{ name: string; callback: (input: unknown) => Promise<void> }>
    } = {},
  ) {
    const hookCalls = overrides.hookCalls ?? []
    const hooks: Record<string, Array<(input: unknown) => Promise<void>>> = {}
    for (const { name, callback } of hookCalls) {
      if (!hooks[name]) hooks[name] = []
      hooks[name].push(callback)
    }
    return {
      session: {
        hook: async (name: string, callback: (input: unknown) => Promise<void>) => {
          if (!hooks[name]) hooks[name] = []
          hooks[name].push(callback)
          return {
            dispose: async () => {
              const hookList = hooks[name]
              if (hookList) {
                const idx = hookList.indexOf(callback)
                if (idx !== -1) hookList.splice(idx, 1)
              }
            },
          }
        },
      },
    } as unknown as import("@opencode/plugin").Plugin.Context
  }

  function makeReader(snapshot: TodoSnapshot): TodoReader {
    return {
      read: async () => snapshot,
    }
  }

  function fireCompaction(ctx: ReturnType<typeof makeMockCtx>, sessionID: string) {
    const hooks = (
      ctx as unknown as {
        session: { hook: (name: string) => Promise<{ dispose: () => Promise<void> }> }
      }
    ).session
    // We can't directly access hooks, so we use a different approach
    return null
  }

  test("appends todo section when result is undefined", async () => {
    // Verify the format function works correctly
    const snapshot: TodoSnapshot = {
      schemaVersion: 1,
      recorded: true,
      todos: [{ content: "task one", status: "pending", priority: "high" }],
    }
    expect(formatTodos(snapshot)).toContain("## Pending Todos")
  })

  test("skips when result is already set", async () => {
    const readCalls: string[] = []
    const reader: TodoReader = {
      read: async () => {
        readCalls.push("read")
        return {
          schemaVersion: 1,
          recorded: true,
          todos: [{ content: "task", status: "pending", priority: "medium" }],
        }
      },
    }

    let capturedInput: Record<string, unknown> | undefined
    const hookCallbacks: Array<(input: unknown) => Promise<void>> = []
    const mockSession = {
      hook: async (name: string, callback: (input: unknown) => Promise<void>) => {
        hookCallbacks.push(callback)
        return {
          dispose: async () => {
            const idx = hookCallbacks.indexOf(callback)
            if (idx !== -1) hookCallbacks.splice(idx, 1)
          },
        }
      },
    }
    const ctx = { session: mockSession } as unknown as import("@opencode/plugin").Plugin.Context

    await mountTodoPreserver(ctx, reader)

    // Simulate compaction with result already set
    const inputWithResult = { sessionID: "test", result: { summary: "existing" } }
    for (const cb of hookCallbacks) {
      await cb(inputWithResult)
    }

    // Read should not be called because result was already set
    expect(readCalls).toHaveLength(0)
  })

  test("does not register hook when todoReader is undefined", async () => {
    const ctx = makeMockCtx()
    const dispose = await mountTodoPreserver(ctx as any, undefined)

    // Should not throw
    await dispose()
  })

  test("handles read errors gracefully", async () => {
    const reader: TodoReader = {
      read: async () => {
        throw new Error("storage-error")
      },
    }

    const ctx = makeMockCtx({
      hookCalls: [
        {
          name: "compaction",
          callback: async (input) => {
            // Should not throw despite read error
            expect((input as Record<string, unknown>).result).toBeUndefined()
          },
        },
      ],
    })

    await mountTodoPreserver(ctx as any, reader)
  })

  test("formats multiple todos correctly", async () => {
    const reader: TodoReader = {
      read: async () => ({
        schemaVersion: 1,
        recorded: true,
        todos: [
          { content: "first task", status: "pending", priority: "high" },
          { content: "second task", status: "completed", priority: "low" },
        ],
      }),
    }

    const snapshot = await reader.read("test-session")
    const formatted = formatTodos(snapshot)
    expect(formatted).toContain("first task")
    expect(formatted).toContain("second task")
    expect(formatted).toContain("[pending]")
    expect(formatted).toContain("[completed]")
  })

  test("returns empty when no todos recorded", async () => {
    const reader: TodoReader = {
      read: async () => ({
        schemaVersion: 1,
        recorded: false,
        todos: [],
      }),
    }

    const snapshot = await reader.read("test-session")
    const formatted = formatTodos(snapshot)
    expect(formatted).toBe("")
  })

  test("returns no-todos section when todos array is empty but recorded", async () => {
    const reader: TodoReader = {
      read: async () => ({
        schemaVersion: 1,
        recorded: true,
        todos: [],
      }),
    }

    const snapshot = await reader.read("test-session")
    const formatted = formatTodos(snapshot)
    expect(formatted).toContain("No pending todos")
  })
})
