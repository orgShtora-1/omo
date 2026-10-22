import { expect, test } from "bun:test"
import type { Evidence, Plan, PlanStep } from "../../src/contracts"
import { buildRevisionLinkage, type RevisionLinkOptions } from "../../src/evidence/revision"

const plan = (steps: readonly PlanStep[], revision = 7): Plan => ({
  schemaVersion: 1,
  id: "p1",
  projectID: "proj",
  parentSessionID: "parent",
  revision,
  createdAt: 1,
  updatedAt: 2,
  steps,
  appliedEvents: [],
})

const step = (id: string, evidence: readonly Evidence[], waiver?: string): PlanStep => ({
  id,
  objective: `objective ${id}`,
  dependencies: [],
  state: "completed",
  attempts: [],
  evidence,
  ...(waiver === undefined ? {} : { waiver }),
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

const sha = "a".repeat(64)

/** A probe that confirms every revision it is asked about. */
const confirming: RevisionLinkOptions = { resolveRevision: async () => "present" }

const recording = () => {
  const asked: string[] = []
  const options: RevisionLinkOptions = {
    resolveRevision: async (revision) => {
      asked.push(revision)
      return "present"
    },
  }
  return { asked, options }
}

test("one revision confirmed by a probe links the evidence to it", async () => {
  const linkage = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1"), ev("ev-2")])]),
    confirming,
  )
  expect(linkage.status).toBe("linked")
  expect(linkage.revisions).toEqual(["0f1e2d3c"])
  expect(linkage.items).toHaveLength(2)
  expect(linkage.items[0]?.corroborations).toEqual([
    { kind: "revision", target: "0f1e2d3c", verdict: "confirmed" },
  ])
  expect(linkage.unreadable).toEqual([])
})

test("the plan record revision is reported as the plan's own counter, never as a code revision", async () => {
  const linkage = await buildRevisionLinkage(plan([step("one", [ev("ev-1")])], 41), confirming)
  expect(linkage.planRecordRevision).toBe(41)
  expect(linkage.revisions).toEqual(["0f1e2d3c"])
  expect(linkage.notes.join(" ")).toContain("not a code revision")
})

test("two revisions are divergent and both are reported, sorted", async () => {
  const linkage = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1")]), step("two", [ev("ev-2", { revision: "9f8e7d6c" })])]),
    confirming,
  )
  expect(linkage.status).toBe("divergent")
  expect(linkage.revisions).toEqual(["0f1e2d3c", "9f8e7d6c"])
})

test("one revision confirmed and one absent is contradicted, and the absent one is named", async () => {
  const linkage = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1")]), step("two", [ev("ev-2", { revision: "9f8e7d6c" })])]),
    { resolveRevision: async (revision) => (revision === "0f1e2d3c" ? "present" : "absent") },
  )
  expect(linkage.status).toBe("contradicted")
  expect(linkage.items[1]?.corroborations[0]?.verdict).toBe("contradicted")
})

test("evidence without a revision keeps the plan out of linked", async () => {
  const linkage = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1")]), step("two", [ev("ev-2", { revision: undefined })])]),
    confirming,
  )
  expect(linkage.status).toBe("unlinked")
  expect(linkage.items[1]?.revision).toBeNull()
  expect(linkage.items[1]?.corroborations).toEqual([])
})

test("a revision nobody declared is unlinked, not linked", async () => {
  const linkage = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1", { revision: undefined })])]),
    confirming,
  )
  expect(linkage.status).toBe("unlinked")
  expect(linkage.revisions).toEqual([])
})

test("a probe that cannot decide leaves the claim asserted and never linked", async () => {
  const linkage = await buildRevisionLinkage(plan([step("one", [ev("ev-1")])]), {
    resolveRevision: async () => "unknown",
  })
  expect(linkage.status).toBe("asserted")
  expect(linkage.items[0]?.corroborations[0]?.verdict).toBe("unverifiable")
})

test("a probe that throws is unverifiable, never contradicted", async () => {
  const linkage = await buildRevisionLinkage(plan([step("one", [ev("ev-1")])]), {
    resolveRevision: () => Promise.reject(new Error("probe exploded")),
  })
  expect(linkage.status).toBe("asserted")
  expect(linkage.items[0]?.corroborations[0]?.verdict).toBe("unverifiable")
  expect(linkage.items[0]?.corroborations[0]?.detail).toContain("probe exploded")
})

test("a probe that observes absence contradicts the claim", async () => {
  const linkage = await buildRevisionLinkage(plan([step("one", [ev("ev-1")])]), {
    resolveRevision: async () => "absent",
  })
  expect(linkage.status).toBe("contradicted")
  expect(linkage.items[0]?.corroborations[0]?.verdict).toBe("contradicted")
})

test("no probe at all can never confirm a revision", async () => {
  const linkage = await buildRevisionLinkage(plan([step("one", [ev("ev-1")])]))
  expect(linkage.status).toBe("asserted")
  expect(linkage.items[0]?.corroborations).toEqual([
    {
      kind: "revision",
      target: "0f1e2d3c",
      verdict: "unverifiable",
      detail: "no corroboration probe was supplied",
    },
  ])
})

test("a declared artifact hash with no artifact probe can never confirm either", async () => {
  // The no-probe guarantee is about both corroboration kinds: an artifact whose
  // hash nobody re-read is an assertion, and must not read as linked.
  const linkage = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1", { artifact: "a.txt", artifactHash: sha })])]),
    confirming,
  )
  expect(linkage.status).toBe("asserted")
  expect(linkage.items[0]?.corroborations[1]).toEqual({
    kind: "artifact",
    target: "a.txt",
    verdict: "unverifiable",
    detail: "no corroboration probe was supplied",
  })
})

test("the same revision is probed once, not once per evidence item", async () => {
  const { asked, options } = recording()
  await buildRevisionLinkage(plan([step("one", [ev("ev-1"), ev("ev-2"), ev("ev-3")])]), options)
  expect(asked).toEqual(["0f1e2d3c"])
})

test("a declared artifact hash is corroborated and a mismatch contradicts", async () => {
  const match = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1", { artifact: "a.txt", artifactHash: sha })])]),
    {
      ...confirming,
      verifyArtifact: async () => "present",
    },
  )
  expect(match.status).toBe("linked")
  expect(match.items[0]?.corroborations).toEqual([
    { kind: "revision", target: "0f1e2d3c", verdict: "confirmed" },
    { kind: "artifact", target: "a.txt", verdict: "confirmed" },
  ])
  const mismatch = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1", { artifact: "a.txt", artifactHash: sha })])]),
    { ...confirming, verifyArtifact: async () => "absent" },
  )
  expect(mismatch.status).toBe("contradicted")
  expect(mismatch.items[0]?.corroborations[1]?.verdict).toBe("contradicted")
})

test("an artifact with no declared hash has nothing to corroborate and does not block linkage", async () => {
  const linkage = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1", { artifact: "a.txt" })])]),
    { ...confirming, verifyArtifact: async () => "present" },
  )
  expect(linkage.status).toBe("linked")
  expect(linkage.items[0]?.corroborations).toHaveLength(1)
})

test("an unverifiable artifact alone is enough to leave the claim asserted", async () => {
  const linkage = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1", { artifact: "a.txt", artifactHash: sha })])]),
    { ...confirming, verifyArtifact: async () => "unknown" },
  )
  expect(linkage.status).toBe("asserted")
})

test("a malformed artifact hash is unverifiable rather than a mismatch", async () => {
  const linkage = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1", { artifact: "a.txt", artifactHash: "not-a-hash" })])]),
    { ...confirming, verifyArtifact: async () => "present" },
  )
  expect(linkage.status).toBe("asserted")
  expect(linkage.items[0]?.corroborations[1]?.verdict).toBe("unverifiable")
  expect(linkage.items[0]?.corroborations[1]?.detail).toContain("sha256")
})

test("a waived step is listed and never counted as unlinked evidence", async () => {
  const linkage = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1")]), step("two", [], "docs only")]),
    {
      ...confirming,
    },
  )
  expect(linkage.status).toBe("linked")
  expect(linkage.waivers).toEqual([{ stepID: "two", waiver: "docs only" }])
  expect(linkage.items.map((item) => item.stepID)).toEqual(["one"])
})

test("a plan with no evidence and no waiver is unlinked and says so", async () => {
  const linkage = await buildRevisionLinkage(plan([step("one", [])]), confirming)
  expect(linkage.status).toBe("unlinked")
  expect(linkage.notes.join(" ")).toContain("no evidence")
})

test("every linkage reports that a declared revision is a caller-stated claim", async () => {
  const linkage = await buildRevisionLinkage(plan([step("one", [ev("ev-1")])]), confirming)
  expect(linkage.notes.join(" ")).toContain("caller-stated")
})

test("a malformed plan names each unreadable path and never reads as linked", async () => {
  const linkage = await buildRevisionLinkage({
    id: "p1",
    revision: 2,
    steps: [{ id: "one", evidence: "nope" }, 7],
  } as unknown as Plan)
  expect(linkage.unreadable).toEqual([
    "plan.projectID: expected a string",
    "plan.parentSessionID: expected a string",
    "steps[0].evidence: expected an array",
    "steps[1]: expected an object",
  ])
  expect(linkage.status).toBe("unlinked")
  expect(linkage.items).toEqual([])
})

test("a malformed evidence list names the offending index", async () => {
  const linkage = await buildRevisionLinkage(
    plan([
      {
        id: "one",
        objective: "objective",
        dependencies: [],
        state: "completed",
        attempts: [],
        evidence: [ev("ev-1"), null, ev("ev-3", { revision: 12 as unknown as string })],
      } as unknown as PlanStep,
    ]),
    confirming,
  )
  expect(linkage.unreadable).toEqual([
    "steps[0].evidence[1]: expected an object",
    "steps[0].evidence[2].revision: expected a string",
  ])
  expect(linkage.status).toBe("unlinked")
  expect(linkage.items).toHaveLength(1)
})

test("an aborted signal probes nothing and never confirms a revision", async () => {
  const controller = new AbortController()
  controller.abort()
  let invoked = 0
  const linkage = await buildRevisionLinkage(plan([step("one", [ev("ev-1")])]), {
    resolveRevision: async () => {
      invoked += 1
      return "present"
    },
    signal: controller.signal,
  })
  expect(invoked).toBe(0)
  expect(linkage.status).toBe("asserted")
})

test("an abort raised while a probe runs stops every later claim from being confirmed", async () => {
  const controller = new AbortController()
  const invoked: string[] = []
  const linkage = await buildRevisionLinkage(
    plan([step("one", [ev("ev-1")]), step("two", [ev("ev-2", { revision: "9f8e7d6c" })])]),
    {
      signal: controller.signal,
      resolveRevision: async (revision) => {
        invoked.push(revision)
        // The signal flips mid-call, after the first claim has been observed.
        controller.abort()
        return "present"
      },
    },
  )
  expect(invoked).toEqual(["0f1e2d3c"])
  expect(linkage.items[1]?.corroborations[0]).toEqual({
    kind: "revision",
    target: "9f8e7d6c",
    verdict: "unverifiable",
    detail: "aborted before the probe ran",
  })
  expect(linkage.notes.join(" ")).toContain("aborted")
})

test("a plan whose own record cannot be fully read is never reported as linked", async () => {
  const linkage = await buildRevisionLinkage(
    { ...plan([step("one", [ev("ev-1")])]), projectID: undefined as unknown as string },
    confirming,
  )
  expect(linkage.unreadable).toEqual(["plan.projectID: expected a string"])
  expect(linkage.status).toBe("asserted")
  expect(linkage.notes.join(" ")).toContain("could not be read")
})

test("a plan record revision that is not a number is reported as null, never invented", async () => {
  const linkage = await buildRevisionLinkage(
    { ...plan([step("one", [ev("ev-1")])]), revision: "two" as unknown as number },
    confirming,
  )
  expect(linkage.planRecordRevision).toBeNull()
  expect(linkage.unreadable).toEqual(["plan.revision: expected a number"])
})

test("the report key set cannot grow a field that would read as proof", async () => {
  const linkage = await buildRevisionLinkage(plan([step("one", [ev("ev-1")])]), confirming)
  expect(Object.keys(linkage).sort()).toEqual([
    "items",
    "notes",
    "planID",
    "planRecordRevision",
    "revisions",
    "schemaVersion",
    "status",
    "unreadable",
    "waivers",
  ])
  expect(Object.keys(linkage.items[0] ?? {}).sort()).toEqual([
    "corroborations",
    "evidenceID",
    "origin",
    "revision",
    "stepID",
  ])
  // A clean confirmation carries no explanation; anything short of one must say why.
  expect(Object.keys(linkage.items[0]?.corroborations[0] ?? {}).sort()).toEqual([
    "kind",
    "target",
    "verdict",
  ])
  const unproven = await buildRevisionLinkage(plan([step("one", [ev("ev-1")])]))
  expect(Object.keys(unproven.items[0]?.corroborations[0] ?? {}).sort()).toEqual([
    "detail",
    "kind",
    "target",
    "verdict",
  ])
  expect(linkage.schemaVersion).toBe(1)
})
