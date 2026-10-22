import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import {
  liveMonitorView,
  lookAtSession,
  type MonitorView,
  monitorStatus,
  mountMonitor,
} from "../../src/terminal/monitor-tools"
import { TmuxMonitor } from "../../src/terminal/tmux"

/** A deterministic view for the pure logic: no tmux, no filesystem. */
const fakeView = (
  sessions: Array<{ runID: string; name: string }>,
  text: Record<string, string> = {},
): MonitorView => ({
  availability: () => ({ available: true }),
  mirrored: () => sessions,
  capture: async (runID) => {
    const captured = text[runID]
    if (captured === undefined) throw new Error(`unknown-session: ${runID}`)
    return captured
  },
})

/** A view that fails closed: consulting the mirror past availability is a bug. */
const unavailableView = (reason: string): MonitorView => ({
  availability: () => ({ available: false, reason }),
  mirrored: () => {
    throw new Error("mirrored must not be consulted when unavailable")
  },
  capture: () => {
    throw new Error("capture must not be consulted when unavailable")
  },
})

/** The fake `tmux` seam from the integration suite; no tmux binary is needed. */
const fakeTmux = () => {
  let owner = ""
  const run = async (_command: string, args: string[]) => {
    if (args.includes("set-option")) {
      const value = args.at(-1)
      if (value === undefined) throw new Error("set-option is missing its value")
      owner = value
    }
    return args.includes("show-options") ? owner : "tmux 3.5"
  }
  return run
}

interface FakeToolDefinition {
  name: string
  description: string
  options: { namespace: string; permission: string }
  output: Record<string, unknown>
  input: Record<string, unknown>
  execute: (input: unknown) => Promise<{ content: string }>
}

interface ToolHarness {
  ctx: Plugin.Context
  definitions: () => FakeToolDefinition[]
  collide: (name: string) => void
  removed: () => number
}

function toolHarness(): ToolHarness {
  let definitions: FakeToolDefinition[] = []
  const existing: Record<string, boolean> = {}
  let removed = 0
  const ctx = {
    tool: {
      transform: async (callback: (editor: unknown) => Promise<void> | void) => {
        const editor = {
          namespace: (_definition: { name: string }) => {},
          get: (name: string) => existing[name] ?? null,
          add: (definition: FakeToolDefinition) => {
            definitions.push(definition)
          },
        }
        await callback(editor)
        return {
          dispose: async () => {
            definitions = []
            removed++
          },
        }
      },
    },
  } as unknown as Plugin.Context
  return {
    ctx,
    definitions: () => definitions,
    collide: (name: string) => {
      existing[name] = true
    },
    removed: () => removed,
  }
}

test("an available monitor reports every session it mirrors, or just the one asked for", () => {
  const view = fakeView([
    { runID: "s1", name: "run-aaa" },
    { runID: "s2", name: "run-bbb" },
  ])
  expect(monitorStatus(view)).toEqual({
    available: true,
    sessions: [
      { runID: "s1", name: "run-aaa" },
      { runID: "s2", name: "run-bbb" },
    ],
  })
  expect(monitorStatus(view, "s2")).toEqual({
    available: true,
    sessions: [{ runID: "s2", name: "run-bbb" }],
  })
})

test("an unavailable monitor fails closed with its reason and never consults the mirror", () => {
  const view = unavailableView("tmux disabled")
  expect(() => monitorStatus(view)).toThrow("monitor-unavailable: tmux disabled")
  expect(() => monitorStatus(view, "s1")).toThrow("monitor-unavailable: tmux disabled")
  expect(lookAtSession(view, "s1")).rejects.toThrow("monitor-unavailable: tmux disabled")
})

test("look_at returns the most recent mirrored text for a session the monitor can see", async () => {
  const view = fakeView(
    [
      { runID: "s1", name: "run-aaa" },
      { runID: "s2", name: "run-bbb" },
    ],
    { s1: "status output 1", s2: "status output 2" },
  )
  expect(await lookAtSession(view, "s1")).toEqual({
    runID: "s1",
    name: "run-aaa",
    text: "status output 1",
  })
})

test("look_at on an unknown session errors instead of inventing output", async () => {
  const view = fakeView([{ runID: "s1", name: "run-aaa" }], { s1: "status output 1" })
  await expect(lookAtSession(view, "missing")).rejects.toThrow("unknown-session: missing")
  expect(() => monitorStatus(view, "missing")).toThrow("unknown-session: missing")
})

test("look_at requires a session and surfaces capture failures explicitly", async () => {
  const view = fakeView([{ runID: "s1", name: "run-aaa" }])
  await expect(lookAtSession(view)).rejects.toThrow("sessionID required")
  await expect(lookAtSession(view, "  ")).rejects.toThrow("sessionID required")
  expect(() => monitorStatus(view, "  ")).toThrow("sessionID required")
  const broken: MonitorView = {
    availability: () => ({ available: true }),
    mirrored: () => [{ runID: "s1", name: "run-aaa" }],
    capture: () => Promise.reject(new Error("ENOENT: mirror file gone")),
  }
  await expect(lookAtSession(broken, "s1")).rejects.toThrow(
    "capture-failed: ENOENT: mirror file gone",
  )
  const thrown: MonitorView = {
    availability: () => ({ available: true }),
    mirrored: () => [{ runID: "s1", name: "run-aaa" }],
    capture: () => Promise.reject("boom"),
  }
  await expect(lookAtSession(thrown, "s1")).rejects.toThrow("capture-failed: boom")
})

test("TmuxMonitor availability fails closed for disabled tmux and Windows hosts", async () => {
  const disabled = new TmuxMonitor({ enabled: false, platform: "linux" })
  expect(disabled.availability()).toEqual({ available: false, reason: "tmux disabled" })
  const windows = new TmuxMonitor({ enabled: true, platform: "win32" })
  const verdict = windows.availability()
  expect(verdict.available).toBe(false)
  expect(verdict.reason).toContain("tmux requires POSIX")
  expect(() => monitorStatus(windows)).toThrow(`monitor-unavailable: ${verdict.reason}`)
  expect(liveMonitorView([disabled, windows]).availability()).toEqual({
    available: false,
    reason: ["tmux disabled", verdict.reason].join("; "),
  })
  await disabled.dispose()
  await windows.dispose()
})

test("TmuxMonitor serves its mirrored sessions and latest text through the run seam", async () => {
  const monitor = new TmuxMonitor({
    enabled: true,
    platform: "linux",
    run: fakeTmux(),
  })
  try {
    expect(monitor.availability()).toEqual({ available: true })
    await monitor.open({ runID: "session-1", text: "first status" })
    await monitor.open({ runID: "session-1", text: "second status" })
    await monitor.open({ runID: "session-2", text: "independent" })
    const mirrored = monitor.mirrored()
    expect(mirrored.map((session) => session.runID)).toEqual(["session-1", "session-2"])
    for (const session of mirrored) expect(session.name).toMatch(/^run-[0-9a-f]{24}$/)
    expect(await monitor.capture("session-1")).toBe("second status")
    expect(await monitor.capture("session-2")).toBe("independent")
    await expect(monitor.capture("missing")).rejects.toThrow("unknown-session: missing")
    const view: MonitorView = monitor
    const first = mirrored[0]
    if (!first) throw new Error("expected a mirrored session")
    expect(monitorStatus(view, "session-1").sessions).toEqual([first])
  } finally {
    await monitor.dispose()
    await monitor.dispose()
  }
  expect(monitor.mirrored()).toEqual([])
})

test("the live aggregate observes active monitors and forgets disposed ones", async () => {
  expect(liveMonitorView([]).availability()).toEqual({
    available: false,
    reason: "no tmux monitor is active",
  })
  const monitor = new TmuxMonitor({
    enabled: true,
    platform: "linux",
    run: fakeTmux(),
  })
  try {
    await monitor.open({ runID: "agg-1", text: "agg status" })
    const view = liveMonitorView()
    expect(view.availability()).toEqual({ available: true })
    expect(view.mirrored().map((session) => session.runID)).toContain("agg-1")
    expect(await view.capture("agg-1")).toBe("agg status")
  } finally {
    await monitor.dispose()
  }
  expect(
    liveMonitorView()
      .mirrored()
      .map((session) => session.runID),
  ).not.toContain("agg-1")
  await expect(liveMonitorView().capture("agg-1")).rejects.toThrow("unknown-session: agg-1")
})

test("mountMonitor registers thin read-only tools that delegate to the injected view", async () => {
  const harness = toolHarness()
  const sessions = [
    { runID: "s1", name: "run-aaa" },
    { runID: "s2", name: "run-bbb" },
  ]
  const view: MonitorView = {
    availability: () => ({ available: true }),
    mirrored: () => sessions,
    capture: async (runID) => `text for ${runID}`,
  }
  const dispose = await mountMonitor(harness.ctx, { view: () => view })
  const definitions = harness.definitions()
  expect(definitions.map((definition) => definition.name)).toEqual(["monitor", "look_at"])
  for (const definition of definitions)
    expect(definition.options).toEqual({ namespace: "omo", permission: "read" })
  const monitorTool = definitions[0]
  if (!monitorTool) throw new Error("monitor tool was not registered")
  const lookTool = definitions[1]
  if (!lookTool) throw new Error("look_at tool was not registered")
  expect(JSON.parse((await monitorTool.execute({})).content)).toEqual({
    available: true,
    sessions,
  })
  expect(JSON.parse((await monitorTool.execute({ sessionID: "s2" })).content)).toEqual({
    available: true,
    sessions: [{ runID: "s2", name: "run-bbb" }],
  })
  await expect(monitorTool.execute({ sessionID: "nope" })).rejects.toThrow("unknown-session: nope")
  expect(JSON.parse((await lookTool.execute({ sessionID: "s1" })).content)).toEqual({
    runID: "s1",
    name: "run-aaa",
    text: "text for s1",
  })
  await expect(lookTool.execute({})).rejects.toThrow("sessionID required")
  await dispose()
})

test("the mounted tools fail closed when the monitor is unavailable", async () => {
  const harness = toolHarness()
  const view = unavailableView("tmux requires POSIX; no tmux on this host")
  const dispose = await mountMonitor(harness.ctx, { view: () => view })
  const definitions = harness.definitions()
  const monitorTool = definitions[0]
  if (!monitorTool) throw new Error("monitor tool was not registered")
  const lookTool = definitions[1]
  if (!lookTool) throw new Error("look_at tool was not registered")
  await expect(monitorTool.execute({})).rejects.toThrow("monitor-unavailable: tmux requires POSIX")
  await expect(lookTool.execute({ sessionID: "s1" })).rejects.toThrow(
    "monitor-unavailable: tmux requires POSIX",
  )
  await dispose()
})

test("mountMonitor registers nothing when the terminal surface is disabled", async () => {
  const harness = toolHarness()
  const view = fakeView([])
  const dispose = await mountMonitor(harness.ctx, {
    terminal: { enabled: false },
    view: () => view,
  })
  expect(harness.definitions()).toEqual([])
  await dispose()
  expect(harness.removed()).toBe(0)
})

test("a tool name collision fails the mount instead of shadowing an existing tool", async () => {
  const harness = toolHarness()
  harness.collide("omo_monitor")
  await expect(mountMonitor(harness.ctx)).rejects.toThrow("monitor tool collision")
  expect(harness.definitions()).toEqual([])
})

test("disposing the mount removes the tools once and is idempotent", async () => {
  const harness = toolHarness()
  const view = fakeView([])
  const dispose = await mountMonitor(harness.ctx, { view: () => view })
  expect(harness.definitions()).toHaveLength(2)
  await dispose()
  await dispose()
  expect(harness.removed()).toBe(1)
  expect(harness.definitions()).toEqual([])
})
