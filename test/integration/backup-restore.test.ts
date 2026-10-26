import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openBoulderStore } from "../../src/boulder/store"
import { goalDirectory, openGoalStore } from "../../src/goal/store"
import { openReflectionQueue } from "../../src/memory/reflection-queue"
import { memoryScope, openMemoryStore } from "../../src/memory/store"
import { createPlan } from "../../src/plans/model"
import { backupState, restoreState } from "../../src/state/backup"
import { openPlanRepository } from "../../src/state/repository"

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
const rmWithRetry = async (root: string) => {
  // Windows releases SQLite file locks asynchronously after close; yield and
  // retry instead of failing the suite on a transient EBUSY.
  let last: unknown
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch (error) {
      last = error
      await Bun.sleep(500)
    }
  }
  throw last
}
const clean = async (...roots: string[]) => {
  for (const root of roots) await rmWithRetry(root)
}

async function seed(stateDir: string) {
  const scope = { projectID: "project", locationID: "loc", parentSessionID: "parent" }
  const plans = openPlanRepository(join(stateDir, "plans.sqlite"))
  await plans.save(
    scope,
    createPlan({
      id: "plan",
      projectID: "project",
      parentSessionID: "parent",
      at: 1,
      steps: [{ id: "build", objective: "Build", dependencies: [] }],
    }),
    null,
  )
  plans.close()
  const memory = openMemoryStore(join(stateDir, "memory.sqlite"))
  memory.save(memoryScope("project", "loc"), { content: "backup canary", key: "canary" })
  memory.close()
  openGoalStore(goalDirectory(stateDir)).set("session-1", "Ship the backup runbook")
  openReflectionQueue(stateDir, "scope").enqueue({
    sessionID: "session-1",
    text: "snapshot text",
    trigger: "manual",
  })
  // The boulder store resolves the plan file from the state dir it is given,
  // so the seed plan lives inside the state dir.
  writeFileSync(join(stateDir, "PLAN.md"), "# plan\n")
  openBoulderStore(stateDir).start("session-1", join(stateDir, "PLAN.md"))
}

describe("backup and restore", () => {
  test("backup captures every state file with a hash manifest", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omo-backup-"))
    const backup = mkdtempSync(join(tmpdir(), "omo-backup-dest-"))
    try {
      await seed(stateDir)
      const manifest = backupState(stateDir, backup)
      const paths = manifest.files.map((file) => file.path).sort()
      for (const expected of [
        "boulder/",
        "goal/",
        "memory.sqlite",
        "plans.sqlite",
        "reflection-queue.sqlite",
      ]) {
        expect(paths.some((path) => path === expected || path.startsWith(expected))).toBe(true)
      }
      for (const file of manifest.files) {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(sha256(join(backup, file.path))).toBe(file.sha256)
      }
    } finally {
      await clean(stateDir, backup)
    }
  })
  test("restore round-trips state after total loss", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omo-restore-"))
    const backup = mkdtempSync(join(tmpdir(), "omo-restore-dest-"))
    try {
      await seed(stateDir)
      backupState(stateDir, backup)
      await rmWithRetry(stateDir)
      restoreState(backup, stateDir)
      const scope = { projectID: "project", locationID: "loc", parentSessionID: "parent" }
      const plans = openPlanRepository(join(stateDir, "plans.sqlite"))
      expect((await plans.load(scope, "plan"))?.steps.map((step) => step.id)).toEqual(["build"])
      plans.close()
      const memory = openMemoryStore(join(stateDir, "memory.sqlite"))
      expect(
        memory.recall(memoryScope("project", "loc"), "canary").map((item) => item.key),
      ).toContain("canary")
      memory.close()
      expect(openGoalStore(goalDirectory(stateDir)).get("session-1")?.objective).toBe(
        "Ship the backup runbook",
      )
      expect(openReflectionQueue(stateDir, "scope").inspect().pending.length).toBe(1)
      expect(openBoulderStore(stateDir).get("session-1")?.status).toBe("active")
    } finally {
      await clean(stateDir, backup)
    }
  })
  test("restore refuses a tampered backup without touching live state", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omo-tamper-"))
    const backup = mkdtempSync(join(tmpdir(), "omo-tamper-dest-"))
    try {
      await seed(stateDir)
      backupState(stateDir, backup)
      const live = join(stateDir, "plans.sqlite")
      const before = sha256(live)
      const copy = join(backup, "plans.sqlite")
      writeFileSync(copy, Buffer.concat([readFileSync(copy), Buffer.from([0])]))
      expect(() => restoreState(backup, stateDir)).toThrow(/backup-corrupt/)
      expect(sha256(live)).toBe(before)
    } finally {
      await clean(stateDir, backup)
    }
  })
})
