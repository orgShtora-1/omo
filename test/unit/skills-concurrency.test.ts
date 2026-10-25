import { describe, expect, it } from "bun:test"
import { invalidateCatalogCache, readAgentsCatalog } from "../../src/skills/catalog.js"

describe("concurrent skill catalog reads", () => {
  it("handles concurrent reads to the same project without corrupting cache", async () => {
    invalidateCatalogCache()
    const mockIo = {
      readDir: async (): Promise<string[]> => ["skill-a", "skill-b", "skill-c"],
      readFile: async (path: string): Promise<string> => `---\nname: ${path}\n---\n`,
      stat: async (): Promise<{ mtimeMs: number }> => ({ mtimeMs: Date.now() }),
    }
    // Fire 10 concurrent reads for the same project
    const promises = Array.from({ length: 10 }, () => readAgentsCatalog("/concurrent-proj", mockIo))
    const results = await Promise.all(promises)
    // All should return the same result
    for (const result of results) {
      expect(result).toHaveLength(3)
    }
    // And they should be identical
    const first = results[0]!
    for (const r of results.slice(1)) {
      expect(r).toEqual(first)
    }
  })

  it("returns consistent results across cache warm and cold reads", async () => {
    invalidateCatalogCache()
    const mockIo = {
      readDir: async (): Promise<string[]> => ["slow-skill"],
      readFile: async (): Promise<string> => "---\nname: slow\n---\n",
      stat: async (): Promise<{ mtimeMs: number }> => ({ mtimeMs: Date.now() }),
    }
    const cold = await readAgentsCatalog("/warmup", mockIo)
    const warm = await readAgentsCatalog("/warmup", mockIo)
    expect(cold).toEqual(warm)
    expect(cold).toHaveLength(1)
  })
})
