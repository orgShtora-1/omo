import { beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  invalidateCatalogCache,
  parseSkillFrontmatter,
  readAgentsCatalog,
} from "../../src/skills/catalog.js"

describe("parseSkillFrontmatter", () => {
  test("extracts plain single-line values", () => {
    const source = "---\nname: my-skill\ndescription: does things\n---\n# body\n"
    expect(parseSkillFrontmatter(source)).toEqual({ name: "my-skill", description: "does things" })
  })

  test("strips surrounding single and double quotes", () => {
    const source = "---\nname: \"quoted-name\"\ndescription: 'quoted description'\n---\nbody\n"
    expect(parseSkillFrontmatter(source)).toEqual({
      name: "quoted-name",
      description: "quoted description",
    })
  })

  test("returns {} without a leading block", () => {
    expect(parseSkillFrontmatter("# no frontmatter\nname: late\n")).toEqual({})
    expect(parseSkillFrontmatter("")).toEqual({})
    expect(parseSkillFrontmatter("intro\n---\nname: late\n---\n")).toEqual({})
  })

  test("ignores entries missing name or description", () => {
    expect(parseSkillFrontmatter("---\ntitle: only\n---\n")).toEqual({})
    expect(parseSkillFrontmatter("---\ndescription: just a description\n---\n")).toEqual({
      description: "just a description",
    })
  })

  test("takes only the first name/description occurrence", () => {
    const source =
      "---\nname: first\nname: second\ndescription: first-desc\ndescription: second-desc\n---\n"
    expect(parseSkillFrontmatter(source)).toEqual({ name: "first", description: "first-desc" })
  })
})

describe("readAgentsCatalog (async)", () => {
  beforeEach(() => {
    invalidateCatalogCache()
  })

  test("returns [] when the skills dir is missing", async () => {
    const result = await readAgentsCatalog("/nonexistent-project", {
      readDir: async (): Promise<string[]> => {
        throw new Error("ENOENT")
      },
      readFile: async (): Promise<string> => {
        throw new Error("unreachable")
      },
      stat: async (): Promise<{ mtimeMs: number }> => {
        throw new Error("unreachable")
      },
    })
    expect(result).toEqual([])
  })

  test("skips entries without SKILL.md or unreadable files", async () => {
    const result = await readAgentsCatalog("/proj", {
      readDir: async (path: string): Promise<string[]> => {
        expect(path.endsWith("skills")).toBe(true)
        return ["good", "empty", "broken"]
      },
      readFile: async (path: string): Promise<string> => {
        if (path.includes("good")) return "---\nname: good-skill\ndescription: works\n---\n"
        throw new Error(`unreadable: ${path}`)
      },
      stat: async (): Promise<{ mtimeMs: number }> => ({ mtimeMs: Date.now() }),
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe("good")
    expect(result[0]?.name).toBe("good-skill")
    expect(result[0]?.description).toBe("works")
    expect(result[0]?.path).toContain("good")
  })

  test("defaults name to id and description to empty string", async () => {
    const result = await readAgentsCatalog("/proj-default-name", {
      readDir: async (): Promise<string[]> => ["plain"],
      readFile: async (): Promise<string> => "# body without frontmatter\n",
      stat: async (): Promise<{ mtimeMs: number }> => ({ mtimeMs: Date.now() }),
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe("plain")
    expect(result[0]?.name).toBe("plain")
    expect(result[0]?.description).toBe("")
  })

  test("reads real SKILL.md files from a tmpdir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-skills-"))
    try {
      const skillDir = join(dir, ".agents", "skills", "demo")
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: demo-skill\ndescription: demo desc\n---\n# demo\n",
      )
      mkdirSync(join(dir, ".agents", "skills", "noskill"), { recursive: true })
      const catalog = await readAgentsCatalog(dir)
      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.id).toBe("demo")
      expect(catalog[0]?.name).toBe("demo-skill")
      expect(catalog[0]?.description).toBe("demo desc")
      expect(catalog[0]?.path).toBe(join(skillDir, "SKILL.md"))
      expect(await readAgentsCatalog(join(dir, "missing"))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("caches results and returns them without I/O on repeat calls", async () => {
    let readCount = 0
    const mockIo = {
      readDir: async (_path: string): Promise<string[]> => {
        readCount++
        return ["my-skill"]
      },
      readFile: async (_path: string): Promise<string> => {
        readCount++
        return "---\nname: my-skill\n---\n"
      },
      stat: async (): Promise<{ mtimeMs: number }> => ({ mtimeMs: Date.now() }),
    }
    // First call does I/O
    const first = await readAgentsCatalog("/proj-cache-a", mockIo)
    expect(first).toHaveLength(1)
    expect(readCount).toBeGreaterThan(0)
    const firstReadCount = readCount
    // Second call should use cache (no additional I/O)
    const second = await readAgentsCatalog("/proj-cache-a", mockIo)
    expect(second).toEqual(first)
    expect(readCount).toBe(firstReadCount) // no new I/O
    // Different project should do I/O again
    const third = await readAgentsCatalog("/proj-cache-b", mockIo)
    expect(third).toHaveLength(1)
    const thirdReadCount = readCount
    expect(readCount).toBeGreaterThan(firstReadCount)
    // Clear cache simulates directory change
    invalidateCatalogCache()
    const fourth = await readAgentsCatalog("/proj-cache-a", mockIo)
    expect(fourth).toEqual(first)
    expect(readCount).toBeGreaterThan(thirdReadCount)
  })

  test("processes skills in batches to limit concurrency", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `skill-${String(i).padStart(2, "0")}`)
    let inFlight = 0
    let maxInFlight = 0
    const mockIo = {
      readDir: async (): Promise<string[]> => ids,
      readFile: async (_path: string): Promise<string> => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        inFlight--
        return "---\nname: test\n---\n"
      },
      stat: async (): Promise<{ mtimeMs: number }> => ({ mtimeMs: Date.now() }),
    }
    const result = await readAgentsCatalog("/proj-batch", mockIo)
    expect(result).toHaveLength(25)
    // Should not have processed all 25 concurrently — batch size is 10
    expect(maxInFlight).toBeLessThan(25)
  })

  test("handles empty skills directory", async () => {
    const result = await readAgentsCatalog("/proj-empty", {
      readDir: async (): Promise<string[]> => [],
      readFile: async (): Promise<string> => "",
      stat: async (): Promise<{ mtimeMs: number }> => ({ mtimeMs: Date.now() }),
    })
    expect(result).toEqual([])
  })
})
