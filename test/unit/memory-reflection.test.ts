import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compileMemoryContext, formatMemories } from "../../src/memory/compile"
import { type MemoryStore, openMemoryStore, type ReflectionKind } from "../../src/memory/store"

const SCOPE_A = JSON.stringify(["shtora.omo.memory", "proj-a", "/work/a"])
const SCOPE_B = JSON.stringify(["shtora.omo.memory", "proj-b", "/work/b"])
const KINDS: ReflectionKind[] = ["correction", "preference", "fact", "decision"]

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), "omo-memory-reflect-"))
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

describe("memory reflection log", () => {
  test("recordReflection stores a timestamped entry per kind", async () => {
    const { file, cleanup } = await tempDb()
    await withStore(file, cleanup, (store) => {
      for (const kind of KINDS) {
        const entry = store.recordReflection(SCOPE_A, {
          kind,
          summary: `summary for ${kind}`,
        })
        expect(entry.id.length).toBeGreaterThan(0)
        expect(entry.kind).toBe(kind)
        expect(entry.summary).toBe(`summary for ${kind}`)
        expect(entry.detail).toBeUndefined()
        expect(entry.recordedAt).toBeGreaterThan(0)
      }
      expect(store.listReflections(SCOPE_A)).toHaveLength(4)
    })
  })

  test("recordReflection rejects invalid kinds, summaries and details", async () => {
    const { file, cleanup } = await tempDb()
    await withStore(file, cleanup, (store) => {
      expect(() => store.recordReflection(SCOPE_A, { kind: "dream", summary: "x" })).toThrow()
      expect(() => store.recordReflection(SCOPE_A, { kind: "fact", summary: "  " })).toThrow()
      expect(() =>
        store.recordReflection(SCOPE_A, { kind: "fact", summary: "x".repeat(2001) }),
      ).toThrow()
      expect(() =>
        store.recordReflection(SCOPE_A, {
          kind: "fact",
          summary: "ok",
          detail: "x".repeat(65537),
        }),
      ).toThrow()
      expect(store.listReflections(SCOPE_A)).toHaveLength(0)
    })
  })

  test("reflection log is append-only, newest-first and isolated per scope", async () => {
    const { file, cleanup } = await tempDb()
    await withStore(file, cleanup, (store) => {
      store.recordReflection(SCOPE_A, { kind: "fact", summary: "same words" })
      store.recordReflection(SCOPE_A, { kind: "fact", summary: "same words" })
      store.recordReflection(SCOPE_B, { kind: "fact", summary: "other scope" })
      const entries = store.listReflections(SCOPE_A)
      expect(entries).toHaveLength(2)
      const [first, second] = entries
      if (!first || !second) throw new Error("expected two reflection entries")
      expect(first.recordedAt).toBeGreaterThanOrEqual(second.recordedAt)
      expect(store.listReflections(SCOPE_A, 1)).toHaveLength(1)
      expect(store.listReflections(SCOPE_B).map((entry) => entry.summary)).toEqual(["other scope"])
    })
  })

  test("reflections survive close and reopen", async () => {
    const { file, cleanup } = await tempDb()
    const first = openMemoryStore(file)
    first.recordReflection(SCOPE_A, { kind: "decision", summary: "use WAL mode" })
    first.close()
    const second = openMemoryStore(file)
    try {
      const entries = second.listReflections(SCOPE_A)
      expect(entries.map((entry) => entry.summary)).toEqual(["use WAL mode"])
    } finally {
      second.close()
      await cleanup()
    }
  })
})

describe("memory compiler", () => {
  test("formatMemories keeps the recall text format", () => {
    expect(
      formatMemories([
        {
          key: "release",
          revision: 2,
          content: "docs/release.md",
          tags: ["release"],
          score: 3,
          updatedAt: 1,
        },
      ]),
    ).toBe("release (rev 2, score 3, tags: release)\ndocs/release.md")
    expect(formatMemories([])).toBe("")
  })

  test("compileMemoryContext merges ranked memories with the latest reflections", async () => {
    const { file, cleanup } = await tempDb()
    await withStore(file, cleanup, (store) => {
      store.save(SCOPE_A, { content: "release checklist lives in docs/release.md" })
      store.recordReflection(SCOPE_A, {
        kind: "correction",
        summary: "staging is the deploy target, not production",
      })
      const compiled = compileMemoryContext(store, SCOPE_A, "release checklist", {
        memoryLimit: 5,
        reflectionLimit: 5,
      })
      expect(compiled).toContain("docs/release.md")
      expect(compiled).toContain("staging is the deploy target")
      const withoutMatch = compileMemoryContext(store, SCOPE_A, "qqqq-nothing", {
        memoryLimit: 5,
        reflectionLimit: 5,
      })
      expect(withoutMatch).toContain("0 match")
      expect(withoutMatch).toContain("staging is the deploy target")
    })
  })
})
