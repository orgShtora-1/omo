import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui"
import { mountTerminal, type TerminalService } from "../../src/terminal/commands"
import { TmuxMonitor } from "../../src/terminal/tmux"
import { mountTerminalUi } from "../../src/terminal/tui"

interface FakeCommandDefinition {
  name: string
  execute: (input: {
    sessionID: string
    prompt: { text: string }
    delivery: string
  }) => Promise<unknown>
}

interface FakeCommandEditor {
  add: (definition: FakeCommandDefinition) => void
}

interface FakeLayerCommand {
  run: () => Promise<unknown>
  enabled: () => boolean
}

interface FakeLayer {
  commands: FakeLayerCommand[]
}

function first<T>(items: readonly T[], what: string): T {
  const head = items[0]
  if (head === undefined) throw new Error(`expected ${what}`)
  return head
}

test("commands dispatch to injected service with session ownership; unload removes registration", async () => {
  let definitions: FakeCommandDefinition[] = []
  const calls: unknown[] = []
  const output: string[] = []
  let removed = 0
  const service: TerminalService = {
    plan: async (input) => {
      calls.push(["plan", input])
      return "created"
    },
    status: async (input) => {
      calls.push(["status", input])
      return "running"
    },
    resume: async (input) => {
      calls.push(["resume", input])
      return "resumed"
    },
    cancel: async (input) => {
      calls.push(["cancel", input])
      return "cancelled"
    },
    compact: async (input) => {
      calls.push(["compact", input])
      return "compacted"
    },
    doctor: async (input) => {
      calls.push(["doctor", input])
      return "healthy"
    },
  }
  const ctx = {
    command: {
      transform: async (callback: (editor: FakeCommandEditor) => void) => {
        callback({ add: (definition: FakeCommandDefinition) => definitions.push(definition) })
        return {
          dispose: async () => {
            definitions = []
            removed++
          },
        }
      },
    },
    session: {
      synthetic: async (input: { text: string }) => {
        output.push(input.text)
      },
    },
  } as unknown as Plugin.Context
  const cleanup = await mountTerminal(ctx, service, { enabled: true })
  expect(definitions.map((d) => d.name)).toEqual([
    "omo-plan",
    "omo-status",
    "omo-resume",
    "omo-cancel",
    "omo-compact",
    "omo-doctor",
  ])
  for (const definition of definitions)
    await definition.execute({ sessionID: "parent", prompt: { text: "plan-1" }, delivery: "queue" })
  expect(calls).toEqual(
    ["plan", "status", "resume", "cancel", "compact", "doctor"].map((name) => [
      name,
      expect.objectContaining({
        sessionID: "parent",
        text: "plan-1",
        signal: expect.any(AbortSignal),
      }),
    ]),
  )
  expect(output).toEqual(["created", "running", "resumed", "cancelled", "compacted", "healthy"])
  await cleanup()
  await cleanup()
  expect(removed).toBe(1)
  expect(definitions).toEqual([])
})

test("tmux opt-in reports Windows capability and never touches user sessions", async () => {
  const disabled = new TmuxMonitor({ enabled: false, platform: "win32" })
  await disabled.open({ runID: "a", text: "status" })
  await disabled.dispose()
  const windows = new TmuxMonitor({ enabled: true, platform: "win32" })
  await expect(windows.open({ runID: "a", text: "status" })).rejects.toMatchObject({
    code: "capability",
  })
})

test("tmux isolates its socket, updates without duplication, and preserves changed ownership", async () => {
  const commands: string[][] = []
  let owner = ""
  const monitor = new TmuxMonitor({
    enabled: true,
    platform: "linux",
    run: async (_command, args) => {
      commands.push(args)
      if (args.includes("set-option")) {
        const value = args.at(-1)
        if (value === undefined) throw new Error("set-option is missing its value")
        owner = value
      }
      return args.includes("show-options") ? owner : "tmux 3.5"
    },
  })
  await monitor.open({ runID: "run with spaces; $(touch bad)", text: "working" })
  await monitor.open({ runID: "run with spaces; $(touch bad)", text: "done" })
  expect(commands.filter((args) => args.includes("new-session"))).toHaveLength(1)
  expect(commands.find((args) => args.includes("new-session"))?.slice(0, 2)).toEqual([
    "-L",
    monitor.socketName,
  ])
  const correctOwner = owner
  owner = "user"
  await expect(monitor.close("run with spaces; $(touch bad)")).rejects.toThrow("ownership")
  expect(commands.some((args) => args.includes("kill-session"))).toBe(false)
  owner = correctOwner
  await monitor.dispose()
  await monitor.dispose()
  expect(commands.filter((args) => args.includes("kill-session"))).toHaveLength(1)
})

test("CLI task dialog dispatches status and cancel to current parent and cleanup disables actions", async () => {
  let layer: FakeLayer | undefined
  let selection = "action:status"
  const dispatched: unknown[] = []
  const ctx = {
    keymap: {
      layer: (factory: () => FakeLayer) => {
        layer = factory()
      },
    },
    data: {
      session: {
        sync: async () => {},
        family: () => ["parent", "child", "advisor", "legacy", "other"],
        list: () => [
          { id: "parent" },
          { id: "child", agent: "executor", title: "Implement" },
          { id: "advisor", agent: "oracle", title: "Review architecture" },
          { id: "legacy", agent: "omo-legacy-profile", title: "Historical task" },
          { id: "other", agent: "user-agent", title: "Other profile" },
          { id: "outside", agent: "executor", title: "Another parent's task" },
        ],
        status: () => "running",
      },
    },
    client: {
      session: {
        command: async (input: unknown) => {
          dispatched.push(input)
        },
      },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "parent" }), navigate: () => {} },
      dialog: {
        select: async (input: { options: Array<{ title: string; value: string }> }) => {
          expect(
            input.options.some((option: { title: string }) => option.title === "Implement"),
          ).toBe(true)
          expect(
            input.options
              .filter((option) => !option.value.startsWith("action:"))
              .map((option) => option.value),
          ).toEqual(["parent", "child", "advisor", "legacy"])
          return selection
        },
        prompt: async () => "plan-1",
      },
    },
  } as unknown as TuiPlugin.Context
  const cleanup = mountTerminalUi(ctx)
  const registered = layer
  if (!registered) throw new Error("terminal keymap layer was not registered")
  const primary = first(registered.commands, "primary terminal command")
  await primary.run()
  selection = "action:cancel"
  await primary.run()
  expect(dispatched).toEqual([
    { sessionID: "parent", name: "omo-status", text: "" },
    { sessionID: "parent", name: "omo-cancel", text: "plan-1" },
  ])
  cleanup()
  expect(primary.enabled()).toBe(false)
  await primary.run()
  expect(dispatched).toHaveLength(2)
})
