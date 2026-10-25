import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openMemoryStore } from "../../src/memory/store"

const SCOPE_A = JSON.stringify(["shtora.omo.memory", "proj-a", "/work/a"])

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omo-memory-fts-"))
  const file = join(dir, "memory.sqlite")
  const store = openMemoryStore(file)
  return {
    store,
    dir,
    file,
    cleanup: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe("memory FTS5 recall", () => {
  test("FTS5 pre-filter works with empty result set", () => {
    const { store, cleanup } = fixture()
    try {
      // No memories saved - should return empty
      const results = store.recall(SCOPE_A, "nothing-matches")
      expect(results).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("recall with exact token match", () => {
    const { store, cleanup } = fixture()
    try {
      store.save(SCOPE_A, { key: "deploy", content: "deploy uses blue-green rollout" })
      const results = store.recall(SCOPE_A, "deploy")
      expect(results).toHaveLength(1)
      expect(results[0]?.key).toBe("deploy")
    } finally {
      cleanup()
    }
  })

  test("recall with partial token match using FTS5", () => {
    const { store, cleanup } = fixture()
    try {
      store.save(SCOPE_A, { key: "test-runner", content: "run the unit tests before commit" })
      const results = store.recall(SCOPE_A, "unit tests")
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0]?.content.toLowerCase()).toContain("unit tests")
    } finally {
      cleanup()
    }
  })

  test("recall respects limit parameter", () => {
    const { store, cleanup } = fixture()
    try {
      store.save(SCOPE_A, { key: "a", content: "first match" })
      store.save(SCOPE_A, { key: "b", content: "second match" })
      store.save(SCOPE_A, { key: "c", content: "third match" })

      const results = store.recall(SCOPE_A, "match", 2)
      expect(results).toHaveLength(2)
    } finally {
      cleanup()
    }
  })

  test("recall returns empty for no-match query", () => {
    const { store, cleanup } = fixture()
    try {
      store.save(SCOPE_A, { key: "xyz", content: "completely different content" })
      const results = store.recall(SCOPE_A, "nonexistent")
      expect(results).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("recall ranking still applies after FTS5 pre-filter", () => {
    const { store, cleanup } = fixture()
    try {
      store.save(SCOPE_A, { key: "deploy.target", content: "deploy target is staging" })
      store.save(SCOPE_A, { key: "lint", content: "biome runs on every commit" })

      const results = store.recall(SCOPE_A, "DEPLOY")
      expect(results.length).toBeGreaterThanOrEqual(1)
      // deploy.target should rank higher because it matches key + content
      expect(results[0]?.key).toBe("deploy.target")
    } finally {
      cleanup()
    }
  })
})
