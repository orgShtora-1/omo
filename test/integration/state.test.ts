import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plan, PlanRepository, Scope } from "../../src/contracts"
import { createPlan } from "../../src/plans/model"
import { transition } from "../../src/plans/transitions"
import { openPlanRepository } from "../../src/state/repository"

const repositories: PlanRepository[] = []
const directories: string[] = []
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const scope = { projectID: "project", locationID: "location", parentSessionID: "parent" }
const plan = () =>
  createPlan({
    id: "plan",
    ...scope,
    at: 100,
    steps: [{ id: "build", objective: "Build", dependencies: [] }],
  })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "omo state with spaces "))
  directories.push(directory)
  const path = join(directory, "plans.sqlite")
  const repository = openPlanRepository(path)
  repositories.push(repository)
  return { repository, path }
}
async function mustLoad(repository: PlanRepository, target: Scope, planID: string): Promise<Plan> {
  const stored = await repository.load(target, planID)
  if (!stored) throw new Error(`expected stored plan ${planID}`)
  return stored
}

test("persists scopes independently across database reopen without mutating snapshots", async () => {
  const { repository, path } = fixture()
  await repository.save(scope, plan(), null)
  expect(await repository.load({ ...scope, locationID: "other-location" }, "plan")).toBeUndefined()
  expect(
    await repository.load({ ...scope, parentSessionID: "other-session" }, "plan"),
  ).toBeUndefined()
  const otherScope = { ...scope, projectID: "other-project" }
  await repository.save(otherScope, { ...plan(), projectID: "other-project" }, null)
  expect(await repository.list(scope)).toHaveLength(1)
  repository.close()
  const reopened = openPlanRepository(path)
  repositories.push(reopened)
  expect(await reopened.load(scope, "plan")).toEqual(plan())
  expect((await reopened.load(otherScope, "plan"))?.projectID).toBe("other-project")
})

test("independent writers cannot overwrite a committed revision and duplicate events preserve it", async () => {
  const { repository, path } = fixture()
  const second = openPlanRepository(path)
  repositories.push(second)
  await repository.save(scope, plan(), null)
  const firstSnapshot = await mustLoad(repository, scope, "plan")
  const secondSnapshot = await mustLoad(second, scope, "plan")
  const event = {
    id: "claim",
    at: 101,
    type: "claim" as const,
    stepID: "build",
    attempt: {
      attemptID: "attempt",
      sessionID: "child",
      parentSessionID: "parent",
      agentID: "executor",
    },
  }
  const claimed = transition(firstSnapshot, event)
  await repository.save(scope, claimed, 0)
  await expect(
    second.save(scope, transition(secondSnapshot, { ...event, id: "other-claim" }), 0),
  ).rejects.toThrow(/revision-conflict/)
  const stored = await mustLoad(second, scope, "plan")
  await second.save(scope, transition(stored, event), 1)
  expect(await repository.load(scope, "plan")).toEqual(claimed)
  await expect(repository.save(scope, plan(), null)).rejects.toThrow(/revision-conflict/)
})

test("invalid JSON, invalid graph, invalid state and future versions are preserved and rejected", async () => {
  const { repository, path } = fixture()
  await repository.save(scope, plan(), null)
  const db = new Database(path)
  try {
    for (const entry of [
      ["{broken", "corrupt-state"],
      [JSON.stringify({ ...plan(), schemaVersion: 2 }), "future-version"],
      [
        JSON.stringify({ ...plan(), steps: [{ ...plan().steps[0], state: "invented" }] }),
        "corrupt-state",
      ],
      [
        JSON.stringify({ ...plan(), steps: [{ ...plan().steps[0], dependencies: ["ghost"] }] }),
        "corrupt-state",
      ],
      [JSON.stringify({ ...plan(), appliedEvents: null }), "corrupt-state"],
      [JSON.stringify({ ...plan(), revision: 99 }), "corrupt-state"],
    ] as Array<[string, string]>) {
      const [payload, error] = entry
      if (error === undefined) throw new Error("expected corruption error label")
      db.query("UPDATE omo_plans SET payload = ? WHERE plan_id = ?").run(payload, "plan")
      await expect(repository.load(scope, "plan")).rejects.toThrow(error)
      await expect(repository.list(scope)).rejects.toThrow(error)
      const row = db.query<{ payload: string }, []>("SELECT payload FROM omo_plans").get()
      if (!row) throw new Error("expected stored payload row")
      expect(row.payload).toBe(payload)
      // A write must not silently replace evidence needed for corruption diagnosis.
      await expect(repository.save(scope, { ...plan(), revision: 1 }, 0)).rejects.toThrow(error)
    }
  } finally {
    db.close(true)
  }
})

test("scope mismatch and malformed in-memory plans never enter storage", async () => {
  const { repository } = fixture()
  await expect(repository.save({ ...scope, projectID: "foreign" }, plan(), null)).rejects.toThrow(
    /scope-mismatch/,
  )
  await expect(
    repository.save(scope, { ...plan(), steps: [] } as unknown as Plan, null),
  ).rejects.toThrow(/corrupt-state/)
  expect(await repository.list(scope)).toEqual([])
})

test("new processes reopen persisted history and concurrent claims through a junction have one winner", async () => {
  const { repository, path } = fixture()
  await repository.save(scope, plan(), null)
  repository.close()
  const aliasRoot = mkdtempSync(join(tmpdir(), "omo junction "))
  directories.push(aliasRoot)
  const alias = join(aliasRoot, "database alias")
  symlinkSync(join(path, ".."), alias, process.platform === "win32" ? "junction" : "dir")
  const moduleURL = pathToFileURL(join(import.meta.dir, "../../src/state/repository.ts")).href
  const transitionURL = pathToFileURL(join(import.meta.dir, "../../src/plans/transitions.ts")).href
  async function child(databasePath: string, eventID?: string) {
    const bun = Bun.which("bun")
    if (!bun) throw new Error("bun executable not found")
    const process = Bun.spawn(
      [
        bun,
        "--eval",
        `
      import { openPlanRepository } from ${JSON.stringify(moduleURL)};
      import { transition } from ${JSON.stringify(transitionURL)};
      const repository = openPlanRepository(${JSON.stringify(databasePath)});
      const scope = ${JSON.stringify(scope)};
      try {
        const plan = await repository.load(scope, "plan");
        ${
          eventID
            ? `await repository.save(scope, transition(${JSON.stringify(plan())}, {
          id: ${JSON.stringify(eventID)}, at: 101, type: "claim", stepID: "build",
          attempt: { attemptID: ${JSON.stringify(eventID)}, sessionID: "child", parentSessionID: "parent", agentID: "executor" }
        }), 0);`
            : ""
        }
        console.log(JSON.stringify(await repository.load(scope, "plan")));
      } catch (error) { console.error(error.code); process.exitCode = 23; }
      finally { repository.close(); }
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [exit, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    return { exit, stdout, stderr }
  }
  const reopened = await child(path)
  expect(reopened.exit).toBe(0)
  expect(JSON.parse(reopened.stdout)).toEqual(plan())
  const results = await Promise.all([
    child(path, "writer-a"),
    child(join(alias, "plans.sqlite"), "writer-b"),
  ])
  expect(results.map((result) => result.exit).sort((a, b) => a - b)).toEqual([0, 23])
  const loser = results.find((result) => result.exit === 23)
  if (!loser) throw new Error("expected one losing writer")
  expect(loser.stderr).toContain("revision-conflict")
  const final = await child(path)
  expect(final.exit).toBe(0)
  const stored = JSON.parse(final.stdout)
  expect(stored.revision).toBe(1)
  expect(stored.appliedEvents).toHaveLength(1)
  expect(stored.steps[0].attempts).toHaveLength(1)
})

test("schema 1 additive fields survive reads and revisions without rewriting stored payloads", async () => {
  const { repository, path } = fixture()
  await repository.save(scope, plan(), null)
  const db = new Database(path)
  const additive = { ...plan(), diagnostics: { note: "preserve extension data" } }
  try {
    db.query("UPDATE omo_plans SET payload = ?").run(JSON.stringify(additive))
  } finally {
    db.close(true)
  }
  const loaded = await mustLoad(repository, scope, "plan")
  expect(loaded).toEqual(additive)
  const blocked = transition(loaded, {
    id: "block",
    at: 101,
    type: "block",
    stepID: "build",
    reason: "Needs input",
  })
  await repository.save(scope, blocked, 0)
  expect(await mustLoad(repository, scope, "plan")).toHaveProperty(
    "diagnostics.note",
    "preserve extension data",
  )
})
