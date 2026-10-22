import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseOptions } from "../../src/config/schema"
import { type MemoryStore, openMemoryStore } from "../../src/memory/store"

const SCOPE_A = JSON.stringify(["shtora.omo.memory", "proj-a", "/work/a"])
const SCOPE_B = JSON.stringify(["shtora.omo.memory", "proj-b", "/work/b"])

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), "omo-memory-"))
  const file = join(dir, "memory.sqlite")
  return {
    file,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** Runs `body` with an open store, always closing before deleting the temp dir
 * (Windows keeps a locked handle otherwise, masking assertion failures with EBUSY). */
async function withStore(
  file: string,
  cleanup: () => Promise<void>,
  body: (store: MemoryStore) => void,
) {
  const store = openMemoryStore(file)
  try {
    body(store)
  } finally {
    store.close()
    await cleanup()
  }
}

describe("memory config", () => {
  test("memory_enabled defaults to false and accepts an explicit boolean", () => {
    expect(
      (parseOptions({ schemaVersion: 1 }) as { memory_enabled?: boolean }).memory_enabled,
    ).toBe(false)
    expect(
      (parseOptions({ schemaVersion: 1, memory_enabled: true }) as { memory_enabled?: boolean })
        .memory_enabled,
    ).toBe(true)
    expect(() => parseOptions({ schemaVersion: 1, memory_enabled: "yes" })).toThrow()
  })
})

describe("memory store save", () => {
  test("creates an entry at revision 1", async () => {
    const { file, cleanup } = await tempDb()
    await withStore(file, cleanup, (store) => {
      const result = store.save(SCOPE_A, { content: "the deploy target is staging" })
      expect(result.status).toBe("created")
      expect(result.revision).toBe(1)
      expect(result.key).toMatch(/^mem-[0-9a-f]{12}$/)
    })
  })

  test("deduplicates identical content without a write", async () => {
    const { file, cleanup } = await tempDb()
    await withStore(file, cleanup, (store) => {
      const first = store.save(SCOPE_A, { content: "same content" })
      const second = store.save(SCOPE_A, { content: "same content" })
      expect(second.status).toBe("unchanged")
      expect(second.key).toBe(first.key)
      expect(second.revision).toBe(1)
    })
  })

  test("updates an explicit key to revision 2 and records history", async () => {
    const { file, cleanup } = await tempDb()
    await withStore(file, cleanup, (store) => {
      store.save(SCOPE_A, { key: "deploy.target", content: "staging" })
      const updated = store.save(SCOPE_A, { key: "deploy.target", content: "production" })
      expect(updated.status).toBe("updated")
      expect(updated.revision).toBe(2)
      const history = store.history(SCOPE_A, "deploy.target")
      expect(history).toHaveLength(2)
      expect(history.map((row) => row.revision)).toEqual([1, 2])
      expect(history[0]?.content).toBe("staging")
      expect(history[1]?.content).toBe("production")
    })
  })

  test("rejects invalid input", async () => {
    const { file, cleanup } = await tempDb()
    await withStore(file, cleanup, (store) => {
      expect(() => store.save(SCOPE_A, { content: "" })).toThrow(/non-empty/)
      expect(() => store.save(SCOPE_A, { content: "   " })).toThrow(/non-empty/)
      expect(() => store.save(SCOPE_A, { content: "x".repeat(65537) })).toThrow(/65536/)
      expect(() => store.save(SCOPE_A, { content: "ok", key: "Bad Key!" })).toThrow(/key/)
      expect(() =>
        store.save(SCOPE_A, {
          content: "ok",
          tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
        }),
      ).toThrow(/tags/)
    })
  })
})

describe("memory store recall", () => {
  test("ranks case-insensitive matches and respects the limit", async () => {
    const { file, cleanup } = await tempDb()
    await withStore(file, cleanup, (store) => {
      store.save(SCOPE_A, {
        key: "deploy",
        content: "deploy uses blue-green rollout; deploy is fully automated",
      })
      store.save(SCOPE_A, { key: "lint", content: "biome runs on every commit" })
      store.save(SCOPE_A, { key: "deploy.notes", content: "deploy twice a week" })
      const results = store.recall(SCOPE_A, "DEPLOY")
      expect(results.length).toBeGreaterThanOrEqual(2)
      expect(results[0]?.key).toBe("deploy")
      for (const item of results) expect(item.content.toLowerCase()).toContain("deploy")
      expect(store.recall(SCOPE_A, "deploy", 1)).toHaveLength(1)
    })
  })

  test("returns an empty list when nothing matches", async () => {
    const { file, cleanup } = await tempDb()
    await withStore(file, cleanup, (store) => {
      store.save(SCOPE_A, { content: "unrelated content" })
      expect(store.recall(SCOPE_A, "zzzz-no-match")).toEqual([])
      expect(() => store.recall(SCOPE_A, "   ")).toThrow(/query/)
    })
  })

  test("isolates scopes so projects never see each other's memories", async () => {
    const { file, cleanup } = await tempDb()
    await withStore(file, cleanup, (store) => {
      store.save(SCOPE_A, { content: "secret of project a" })
      expect(store.recall(SCOPE_A, "secret")).toHaveLength(1)
      expect(store.recall(SCOPE_B, "secret")).toEqual([])
    })
  })

  test("persists across a close and reopen cycle", async () => {
    const { file, cleanup } = await tempDb()
    try {
      const store = openMemoryStore(file)
      store.save(SCOPE_A, { key: "persisted", content: "restart survivor" })
      store.close()
      const reopened = openMemoryStore(file)
      try {
        const results = reopened.recall(SCOPE_A, "survivor")
        expect(results).toHaveLength(1)
        expect(results[0]?.key).toBe("persisted")
        expect(results[0]?.revision).toBe(1)
      } finally {
        reopened.close()
      }
    } finally {
      await cleanup()
    }
  })
})
