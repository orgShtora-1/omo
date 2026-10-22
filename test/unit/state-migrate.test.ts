import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { sha256File } from "../../src/state/files"
import { legacyStateDir, type MigrationOutcome, migrateLegacyState } from "../../src/state/migrate"

const DURABLE_CONTENT: Record<string, string> = {
  "boulder/boulder.md": "boulder-bytes",
  "goal/goal.md": "goal-bytes",
  "memory.sqlite": "memory-bytes",
  "memory.sqlite-wal": "wal-bytes",
  "plans.sqlite": "plans-bytes",
  "teams.sqlite": "teams-bytes",
}
const DURABLE_RELS = Object.keys(DURABLE_CONTENT).sort()

interface Fixture {
  root: string
  canonical: string
  legacy: string
  stateHome: string
}

function withFixture(run: (fixture: Fixture) => void): void {
  const root = mkdtempSync(join(tmpdir(), "omo-migrate-"))
  try {
    const canonical = join(root, "proj")
    mkdirSync(canonical, { recursive: true })
    run({
      root,
      canonical,
      legacy: legacyStateDir(canonical),
      stateHome: join(root, "state-home"),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeLegacyDurable(legacy: string): void {
  for (const [rel, content] of Object.entries(DURABLE_CONTENT)) {
    const full = join(legacy, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

function expectMigrated(outcome: MigrationOutcome) {
  if (outcome.status !== "migrated") {
    throw new Error(`expected status "migrated", received "${outcome.status}"`)
  }
  return outcome
}

function expectFailed(outcome: MigrationOutcome) {
  if (outcome.status !== "failed") {
    throw new Error(`expected status "failed", received "${outcome.status}"`)
  }
  return outcome
}

describe("legacyStateDir", () => {
  test("points at <canonical>/.opencode/omo", () => {
    const canonical = join(tmpdir(), "proj")
    expect(legacyStateDir(canonical)).toBe(join(canonical, ".opencode", "omo"))
  })
})

describe("migrateLegacyState", () => {
  test("returns no-legacy and creates nothing when .opencode/omo does not exist", () => {
    withFixture((fixture) => {
      const outcome = migrateLegacyState({
        projectCanonical: fixture.canonical,
        stateHome: fixture.stateHome,
      })
      expect(outcome).toEqual({ status: "no-legacy" })
      expect(existsSync(fixture.stateHome)).toBe(false)
    })
  })

  test("migrates durable files with identical hashes, skips runtime.lock and renames the legacy dir", () => {
    withFixture((fixture) => {
      const { canonical, legacy, stateHome } = fixture
      writeLegacyDurable(legacy)
      writeFileSync(join(legacy, "runtime.lock"), "locked")

      const outcome = migrateLegacyState({ projectCanonical: canonical, stateHome })
      const migrated = expectMigrated(outcome)

      expect(migrated.raced).toBe(false)
      expect(migrated.renameFailed).toBe(false)
      expect([...migrated.copied].sort()).toEqual(DURABLE_RELS)

      const moved = join(dirname(legacy), "omo.migrated")
      expect(existsSync(legacy)).toBe(false)
      expect(existsSync(moved)).toBe(true)
      expect(existsSync(join(moved, "runtime.lock"))).toBe(true)
      for (const [rel, content] of Object.entries(DURABLE_CONTENT)) {
        const target = join(stateHome, rel)
        expect(existsSync(target)).toBe(true)
        expect(sha256File(target)).toBe(sha256File(join(moved, rel)))
        expect(readFileSync(target, "utf8")).toBe(content)
      }
      expect(existsSync(join(stateHome, "runtime.lock"))).toBe(false)
      // Idempotent: the legacy dir is gone, so a second call is a no-op.
      expect(migrateLegacyState({ projectCanonical: canonical, stateHome })).toEqual({
        status: "no-legacy",
      })
    })
  })

  test("skips and leaves the legacy dir untouched when the target already has state", () => {
    withFixture((fixture) => {
      const { canonical, legacy, stateHome } = fixture
      writeLegacyDurable(legacy)
      mkdirSync(stateHome, { recursive: true })
      writeFileSync(join(stateHome, "plans.sqlite"), "existing-state")

      const outcome = migrateLegacyState({ projectCanonical: canonical, stateHome })

      expect(outcome).toEqual({ status: "skipped-target-has-state" })
      expect(existsSync(legacy)).toBe(true)
      expect(readFileSync(join(legacy, "plans.sqlite"), "utf8")).toBe("plans-bytes")
      expect(readFileSync(join(stateHome, "plans.sqlite"), "utf8")).toBe("existing-state")
      expect(existsSync(join(dirname(legacy), "omo.migrated"))).toBe(false)
    })
  })

  test("reports raced when the legacy dir disappears before the rename", () => {
    withFixture((fixture) => {
      const { canonical, legacy, stateHome } = fixture
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, "plans.sqlite"), "plans-bytes")

      const outcome = migrateLegacyState({
        projectCanonical: canonical,
        stateHome,
        hooks: {
          beforeRename: () => rmSync(legacy, { recursive: true, force: true }),
        },
      })

      expect(outcome).toEqual({
        status: "migrated",
        copied: ["plans.sqlite"],
        raced: true,
        renameFailed: false,
      })
      expect(readFileSync(join(stateHome, "plans.sqlite"), "utf8")).toBe("plans-bytes")
    })
  })

  test("reports renameFailed and keeps the legacy dir when the rename fails", () => {
    withFixture((fixture) => {
      const { canonical, legacy, stateHome } = fixture
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, "plans.sqlite"), "plans-bytes")

      const outcome = migrateLegacyState({
        projectCanonical: canonical,
        stateHome,
        hooks: {
          rename: () => {
            throw new Error("EPERM: the process cannot access the file")
          },
        },
      })

      expect(outcome).toEqual({
        status: "migrated",
        copied: ["plans.sqlite"],
        raced: false,
        renameFailed: true,
      })
      expect(existsSync(legacy)).toBe(true)
      expect(sha256File(join(stateHome, "plans.sqlite"))).toBe(
        sha256File(join(legacy, "plans.sqlite")),
      )
      expect(existsSync(join(dirname(legacy), "omo.migrated"))).toBe(false)
    })
  })

  test("falls back to omo.migrated-<epoch> when omo.migrated already exists", () => {
    withFixture((fixture) => {
      const { canonical, legacy, stateHome } = fixture
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, "plans.sqlite"), "plans-bytes")
      const parent = dirname(legacy)
      mkdirSync(join(parent, "omo.migrated"), { recursive: true })
      writeFileSync(join(parent, "omo.migrated", "sentinel.txt"), "previous")

      const outcome = migrateLegacyState({
        projectCanonical: canonical,
        stateHome,
        now: () => 12345,
      })
      const migrated = expectMigrated(outcome)

      expect(migrated.copied).toEqual(["plans.sqlite"])
      const epochDir = join(parent, "omo.migrated-12345")
      expect(existsSync(legacy)).toBe(false)
      expect(existsSync(epochDir)).toBe(true)
      expect(readFileSync(join(epochDir, "plans.sqlite"), "utf8")).toBe("plans-bytes")
      expect(readFileSync(join(parent, "omo.migrated", "sentinel.txt"), "utf8")).toBe("previous")
    })
  })

  test("fails and cleans partial copies when a copied file diverges after copy", () => {
    withFixture((fixture) => {
      const { canonical, legacy, stateHome } = fixture
      writeLegacyDurable(legacy)
      let firstRel: string | null = null
      let calls = 0

      const outcome = migrateLegacyState({
        projectCanonical: canonical,
        stateHome,
        hooks: {
          beforeCopy: (rel) => {
            calls += 1
            if (calls === 1) {
              firstRel = rel
              return
            }
            if (calls === 2 && firstRel) writeFileSync(join(stateHome, firstRel), "corrupted")
          },
        },
      })
      const failed = expectFailed(outcome)

      expect(failed.error.length).toBeGreaterThan(0)
      expect([...failed.copied].sort()).toEqual(DURABLE_RELS)
      for (const [rel, content] of Object.entries(DURABLE_CONTENT)) {
        expect(existsSync(join(stateHome, rel))).toBe(false)
        expect(readFileSync(join(legacy, rel), "utf8")).toBe(content)
      }
      expect(existsSync(join(dirname(legacy), "omo.migrated"))).toBe(false)
    })
  })

  test("fails with an intact legacy and clean destination when beforeCopy throws", () => {
    withFixture((fixture) => {
      const { canonical, legacy, stateHome } = fixture
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, "plans.sqlite"), "plans-bytes")
      writeFileSync(join(legacy, "teams.sqlite"), "teams-bytes")

      const outcome = migrateLegacyState({
        projectCanonical: canonical,
        stateHome,
        hooks: {
          beforeCopy: () => {
            throw new Error("disk full")
          },
        },
      })
      const failed = expectFailed(outcome)

      expect(failed.copied).toEqual([])
      expect(failed.error).toContain("disk full")
      expect(existsSync(legacy)).toBe(true)
      expect(existsSync(join(legacy, "plans.sqlite"))).toBe(true)
      expect(existsSync(join(legacy, "teams.sqlite"))).toBe(true)
      const entries = existsSync(stateHome) ? readdirSync(stateHome) : []
      expect(entries).toEqual([])
    })
  })
})
