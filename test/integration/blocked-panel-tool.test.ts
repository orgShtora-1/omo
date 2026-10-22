import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { BlockedPanel } from "../../src/diagnostics/panel"
import { mountBlockedPanel } from "../../src/diagnostics/tool"

interface PanelResult {
  content: string
  output?: unknown
}

interface Registration {
  name: string
  options?: { namespace?: string; permission?: string }
}

function fixture(payload: unknown, collision = false) {
  const registrations: Registration[] = []
  let statusCalls = 0
  const toolCtx = {
    tool: {
      transform: async (
        callback: (editor: {
          get(): undefined
          namespace(value: { name: string }): void
          add(value: Registration & { execute: PanelHandle["execute"] }): void
        }) => void,
      ) => {
        callback({
          get: () => (collision ? ({ id: "omo_blocked" } as never) : undefined),
          namespace: () => {},
          add: (value) => registrations.push(value),
        })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context
  return {
    registrations,
    toolCtx,
    statusCalls: () => statusCalls,
    mount: () =>
      mountBlockedPanel(toolCtx, {
        status: async () => {
          statusCalls += 1
          return payload
        },
      }),
  }
}

interface PanelHandle {
  execute: (
    args: Record<string, unknown>,
    context: { sessionID: string; signal?: AbortSignal },
  ) => Promise<PanelResult>
}

const blockedStatus = {
  plans: [
    {
      schemaVersion: 1,
      id: "plan-1",
      projectID: "proj",
      parentSessionID: "parent",
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      steps: [
        {
          id: "step-1",
          objective: "Reconcile",
          dependencies: [],
          state: "blocked",
          attempts: [],
          evidence: [],
          reason: "delegate-reported-failure",
        },
      ],
      appliedEvents: [],
    },
  ],
  runs: [
    {
      attemptID: "attempt-1",
      taskID: "task-1",
      phase: "blocked",
      error: "admission-timeout",
      updatedAt: 3,
    },
  ],
  scheduler: { active: 0, queued: 0 },
}

const registered = (registrations: Registration[]) => {
  const found = registrations.find((entry) => entry.name === "blocked")
  if (!found) throw new Error("omo_blocked was not registered")
  return found as unknown as { execute: PanelHandle["execute"] }
}

test("registers omo_blocked in the omo namespace as a read permission", async () => {
  const host = fixture(blockedStatus)
  await host.mount()
  expect(host.registrations.map((entry) => entry.name)).toEqual(["blocked"])
  expect(host.registrations[0]?.options).toEqual({ namespace: "omo", permission: "read" })
})

test("returns the panel derived from the runtime status source, scoped to the caller", async () => {
  const host = fixture(blockedStatus)
  await host.mount()
  const result = await registered(host.registrations).execute({}, { sessionID: "parent" })
  const panel = result.output as BlockedPanel
  expect(panel.parentSessionID).toBe("parent")
  expect(panel.status).toBe("blocked")
  expect(panel.blockedRuns).toHaveLength(1)
  expect(panel.blockedSteps[0]).toMatchObject({ planID: "plan-1", stepID: "step-1" })
  expect(result.content).toBe(JSON.stringify(panel, null, 2))
})

test("reads the status source exactly once and never mutates the payload", async () => {
  const payload = structuredClone(blockedStatus)
  const host = fixture(payload)
  await host.mount()
  await registered(host.registrations).execute({}, { sessionID: "parent" })
  expect(host.statusCalls()).toBe(1)
  expect(payload).toEqual(blockedStatus)
})

test("a malformed status payload surfaces as unknown instead of an empty panel", async () => {
  const host = fixture({ plans: "not a list" })
  await host.mount()
  const result = await registered(host.registrations).execute({}, { sessionID: "parent" })
  const panel = result.output as BlockedPanel
  expect(panel.status).toBe("unknown")
  expect(panel.unreadable).toEqual(["runs: expected an array", "plans: expected an array"])
  expect(panel.blockedRuns).toEqual([])
})

test("refuses to register when omo_blocked already exists", async () => {
  const host = fixture(blockedStatus, true)
  await expect(host.mount()).rejects.toThrow("tool collision: omo_blocked")
  expect(host.registrations).toEqual([])
})

test("an aborted call collects nothing and never reads the status source", async () => {
  const host = fixture(blockedStatus)
  await host.mount()
  const controller = new AbortController()
  controller.abort()
  await expect(
    registered(host.registrations).execute({}, { sessionID: "parent", signal: controller.signal }),
  ).rejects.toThrow("aborted: blocked-runs panel not collected")
  expect(host.statusCalls()).toBe(0)
})

test("an abort during the status read still refuses to report a panel", async () => {
  const registrations: Registration[] = []
  const controller = new AbortController()
  const toolCtx = {
    tool: {
      transform: async (
        callback: (editor: {
          get(): undefined
          namespace(value: { name: string }): void
          add(value: Registration & { execute: PanelHandle["execute"] }): void
        }) => void,
      ) => {
        callback({
          get: () => undefined,
          namespace: () => {},
          add: (value) => registrations.push(value),
        })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context
  await mountBlockedPanel(toolCtx, {
    status: async () => {
      controller.abort()
      return blockedStatus
    },
  })
  await expect(
    registered(registrations).execute({}, { sessionID: "parent", signal: controller.signal }),
  ).rejects.toThrow("aborted: blocked-runs panel not collected")
})

test("disposal unregisters the panel tool", async () => {
  const registrations: Registration[] = []
  let disposed = 0
  const toolCtx = {
    tool: {
      transform: async (
        callback: (editor: {
          get(): undefined
          namespace(value: { name: string }): void
          add(value: Registration & { execute: PanelHandle["execute"] }): void
        }) => void,
      ) => {
        callback({
          get: () => undefined,
          namespace: () => {},
          add: (value) => registrations.push(value),
        })
        return {
          dispose: async () => {
            disposed += 1
          },
        }
      },
    },
  } as unknown as Plugin.Context
  const dispose = await mountBlockedPanel(toolCtx, { status: async () => blockedStatus })
  await dispose()
  expect(disposed).toBe(1)
})
