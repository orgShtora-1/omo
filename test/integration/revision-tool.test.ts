import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { Evidence, Plan, PlanStep } from "../../src/contracts"
import type { ProbeVerdict, RevisionLinkOptions } from "../../src/evidence/revision"
import { mountRevisionLink, type RevisionLinkReport } from "../../src/evidence/tool"

interface Registration {
  name: string
  description?: string
  options?: { namespace?: string; permission?: string }
  execute: (
    args: Record<string, unknown>,
    context: { sessionID: string; signal?: AbortSignal },
  ) => Promise<{ content: string; output?: unknown }>
}

const step = (id: string, evidence: readonly Evidence[]): PlanStep => ({
  id,
  objective: `objective ${id}`,
  dependencies: [],
  state: "completed",
  attempts: [],
  evidence,
})

const ev = (id: string, overrides: Partial<Evidence> = {}): Evidence => ({
  id,
  description: "the executed gate",
  command: "bun run check",
  exitCode: 0,
  revision: "0f1e2d3c",
  origin: "auto",
  ...overrides,
})

const plan = (id: string, parentSessionID = "parent"): Plan => ({
  schemaVersion: 1,
  id,
  projectID: "proj",
  parentSessionID,
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
  steps: [step("one", [ev("ev-1")])],
  appliedEvents: [],
})

function fixture(
  options: {
    plans?: readonly Plan[]
    load?: (sessionID: string, planID: string) => Promise<Plan | undefined>
    collide?: boolean
  } = {},
) {
  const registrations: Registration[] = []
  const stored = options.plans ?? [plan("p1")]
  let loads = 0
  let lists = 0
  const signals: (AbortSignal | undefined)[] = []
  const probes: RevisionLinkOptions[] = []
  const toolCtx = {
    tool: {
      transform: async (
        callback: (editor: {
          get(): undefined
          namespace(value: { name: string }): void
          add(value: Registration): void
        }) => void,
      ) => {
        callback({
          get: () => (options.collide ? ({ id: "omo_revision" } as never) : undefined),
          namespace: () => {},
          add: (value) => registrations.push(value),
        })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context
  return {
    registrations,
    signals,
    probes,
    counts: () => ({ loads, lists }),
    mount: () =>
      mountRevisionLink(toolCtx, {
        loadPlan: async (sessionID, planID) => {
          loads += 1
          return options.load
            ? options.load(sessionID, planID)
            : stored.find((it) => it.id === planID)
        },
        listPlans: async () => {
          lists += 1
          return stored
        },
        probes: (signal) => {
          signals.push(signal)
          const built: RevisionLinkOptions = {
            resolveRevision: async (): Promise<ProbeVerdict> => "present",
            verifyArtifact: async (): Promise<ProbeVerdict> => "present",
          }
          probes.push(built)
          return built
        },
      }),
  }
}

const call = (
  host: ReturnType<typeof fixture>,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
) =>
  (host.registrations[0] as Registration).execute(args, {
    sessionID: "parent",
    ...(signal ? { signal } : {}),
  })

test("registers omo_revision inside the omo namespace with read permission", async () => {
  const host = fixture()
  await host.mount()
  const registration = host.registrations[0]
  expect(registration?.name).toBe("revision")
  expect(registration?.options).toEqual({ namespace: "omo", permission: "read" })
})

test("reports the linkage of every plan stored for the session", async () => {
  const host = fixture({ plans: [plan("p1"), plan("p2")] })
  await host.mount()
  const report = (await call(host)).output as RevisionLinkReport
  expect(report.plans.map((item) => item.planID)).toEqual(["p1", "p2"])
  expect(report.plans.map((item) => item.status)).toEqual(["linked", "linked"])
  expect(report.unreadable).toEqual([])
})

test("a named plan is read on its own and the list is never touched", async () => {
  const host = fixture({ plans: [plan("p1"), plan("p2")] })
  await host.mount()
  const report = (await call(host, { planID: "p2" })).output as RevisionLinkReport
  expect(report.plans.map((item) => item.planID)).toEqual(["p2"])
  expect(host.counts()).toEqual({ loads: 1, lists: 0 })
})

test("a plan that is not stored is reported as absent, never as an empty linkage", async () => {
  const host = fixture({ plans: [plan("p1")] })
  await host.mount()
  const report = (await call(host, { planID: "missing" })).output as RevisionLinkReport
  expect(report.plans).toEqual([])
  expect(report.notes.join(" ")).toContain("missing")
})

test("a plan that cannot be read is named and never given a fabricated linkage", async () => {
  const host = fixture({
    load: () => Promise.reject(new Error("the store is locked")),
  })
  await host.mount()
  const report = (await call(host, { planID: "p1" })).output as RevisionLinkReport
  expect(report.plans).toEqual([])
  expect(report.unreadable).toEqual(["p1: the store is locked"])
  expect(report.notes.join(" ")).toContain("p1")
})

test("a read that failed never also claims the plan is not stored", async () => {
  const host = fixture({
    load: () => Promise.reject(new Error("the store is locked")),
  })
  await host.mount()
  const report = (await call(host, { planID: "p1" })).output as RevisionLinkReport
  expect(report.notes.join(" ")).toContain("could not be read")
  // An unreadable plan proves nothing about what is stored: saying it is absent
  // on top of saying it could not be read would contradict the report's own
  // unreadable entry.
  expect(report.notes.join(" ")).not.toContain("is stored for this session")
  expect(report.unreadable).toEqual(["p1: the store is locked"])
})

test("a store that cannot be enumerated fails the call instead of reporting fewer plans", async () => {
  const host = fixture({ plans: [] })
  const throwing = {
    ...host,
    mount: () =>
      mountRevisionLink(
        {
          tool: {
            transform: async (callback: (editor: never) => void) => {
              callback({
                get: () => undefined,
                namespace: () => {},
                add: (value: Registration) => host.registrations.push(value),
              } as never)
              return { dispose: async () => {} }
            },
          },
        } as unknown as Plugin.Context,
        {
          loadPlan: async () => undefined,
          listPlans: () => Promise.reject(new Error("the store is locked")),
          probes: () => ({}),
        },
      ),
  }
  await throwing.mount()
  await expect(call(throwing as never)).rejects.toThrow("could not read the plan store")
})

test("a plan owned by another session is excluded and counted", async () => {
  const host = fixture({ plans: [plan("p1"), plan("foreign", "someone-else")] })
  await host.mount()
  const report = (await call(host)).output as RevisionLinkReport
  expect(report.plans.map((item) => item.planID)).toEqual(["p1"])
  expect(report.notes.join(" ")).toContain("foreign")
})

test("the caller's signal reaches the probes so a spawn can be cancelled", async () => {
  const host = fixture()
  await host.mount()
  const controller = new AbortController()
  await call(host, {}, controller.signal)
  expect(host.signals).toEqual([controller.signal])
})

test("an abort raised during the probe phase refuses the report whatever the probe factory did", async () => {
  const controller = new AbortController()
  const registrations: Registration[] = []
  const toolCtx = {
    tool: {
      transform: async (
        callback: (editor: {
          get(): undefined
          namespace(value: { name: string }): void
          add(value: Registration): void
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
  await mountRevisionLink(toolCtx, {
    loadPlan: async () => undefined,
    listPlans: async () => [plan("p1")],
    // Deliberately drops the signal on the floor: a caller that forgets to
    // forward it must not have a cancellation ignored. The read has already
    // finished by the time this runs, so the abort is only visible to a check
    // made after the probe phase.
    probes: () => ({
      resolveRevision: async (): Promise<ProbeVerdict> => {
        controller.abort()
        return "present"
      },
    }),
  })
  await expect(
    (registrations[0] as Registration).execute(
      {},
      { sessionID: "parent", signal: controller.signal },
    ),
  ).rejects.toThrow("aborted")
})

test("a planID that is not a string is refused instead of widening into a full listing", async () => {
  const host = fixture({ plans: [plan("p1"), plan("p2")] })
  await host.mount()
  await expect(call(host, { planID: 123 })).rejects.toThrow("planID must be a single string")
  expect(host.counts()).toEqual({ loads: 0, lists: 0 })
})

test("a blank planID is refused too rather than reporting every stored plan", async () => {
  const host = fixture({ plans: [plan("p1"), plan("p2")] })
  await host.mount()
  await expect(call(host, { planID: "   " })).rejects.toThrow("planID must name a plan")
  expect(host.counts()).toEqual({ loads: 0, lists: 0 })
})

test("probes are built per call so no verdict outlives the call that observed it", async () => {
  const host = fixture()
  await host.mount()
  await call(host)
  await call(host)
  expect(host.probes).toHaveLength(2)
  expect(host.probes[0]).not.toBe(host.probes[1])
})

test("an aborted call reads nothing", async () => {
  const host = fixture()
  await host.mount()
  const controller = new AbortController()
  controller.abort()
  await expect(call(host, {}, controller.signal)).rejects.toThrow("aborted")
  expect(host.counts()).toEqual({ loads: 0, lists: 0 })
  expect(host.probes).toEqual([])
})

test("an abort during the read still refuses to report a linkage", async () => {
  const controller = new AbortController()
  const host = fixture({
    load: async (_sessionID, planID) => {
      controller.abort()
      return plan(planID)
    },
  })
  await host.mount()
  await expect(call(host, { planID: "p1" }, controller.signal)).rejects.toThrow("aborted")
})

test("refuses to register when omo_revision already exists", async () => {
  const host = fixture({ collide: true })
  await expect(host.mount()).rejects.toThrow("tool collision: omo_revision")
  expect(host.registrations).toEqual([])
})

test("disposal unregisters the revision tool", async () => {
  const registrations: Registration[] = []
  let disposed = 0
  const toolCtx = {
    tool: {
      transform: async (
        callback: (editor: {
          get(): undefined
          namespace(value: { name: string }): void
          add(value: Registration): void
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
  const dispose = await mountRevisionLink(toolCtx, {
    loadPlan: async () => undefined,
    listPlans: async () => [],
    probes: () => ({}),
  })
  await dispose()
  expect(disposed).toBe(1)
})

test("the report key set cannot grow a field that would read as proof", async () => {
  const host = fixture()
  await host.mount()
  const report = (await call(host)).output as RevisionLinkReport
  expect(Object.keys(report).sort()).toEqual([
    "generatedAt",
    "notes",
    "plans",
    "schemaVersion",
    "unreadable",
  ])
  expect(report.schemaVersion).toBe(1)
})
