import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSkillFrontmatter, readAgentsCatalog } from "../../src/skills/catalog.js"

test("parseSkillFrontmatter extracts plain single-line values", () => {
  const source = "---\nname: my-skill\ndescription: does things\n---\n# body\n"
  expect(parseSkillFrontmatter(source)).toEqual({ name: "my-skill", description: "does things" })
})

test("parseSkillFrontmatter strips surrounding single and double quotes", () => {
  const source = "---\nname: \"quoted-name\"\ndescription: 'quoted description'\n---\nbody\n"
  expect(parseSkillFrontmatter(source)).toEqual({
    name: "quoted-name",
    description: "quoted description",
  })
})

test("parseSkillFrontmatter returns {} without a leading block", () => {
  expect(parseSkillFrontmatter("# no frontmatter\nname: late\n")).toEqual({})
  expect(parseSkillFrontmatter("")).toEqual({})
  expect(parseSkillFrontmatter("intro\n---\nname: late\n---\n")).toEqual({})
})

test("parseSkillFrontmatter ignores entries missing name or description", () => {
  expect(parseSkillFrontmatter("---\ntitle: only\n---\n")).toEqual({})
  expect(parseSkillFrontmatter("---\ndescription: just a description\n---\n")).toEqual({
    description: "just a description",
  })
})

test("readAgentsCatalog returns [] when the skills dir is missing", () => {
  const result = readAgentsCatalog("/nonexistent-project", {
    readDir: (): string[] => {
      throw new Error("ENOENT")
    },
    readFile: (): string => {
      throw new Error("unreachable")
    },
  })
  expect(result).toEqual([])
})

test("readAgentsCatalog skips entries without SKILL.md or unreadable files", () => {
  const result = readAgentsCatalog("/proj", {
    readDir: (path: string): string[] => {
      expect(path.endsWith("skills")).toBe(true)
      return ["good", "empty", "broken"]
    },
    readFile: (path: string): string => {
      if (path.includes("good")) return "---\nname: good-skill\ndescription: works\n---\n"
      throw new Error(`unreadable: ${path}`)
    },
  })
  expect(result).toHaveLength(1)
  expect(result[0]?.id).toBe("good")
  expect(result[0]?.name).toBe("good-skill")
  expect(result[0]?.description).toBe("works")
  expect(result[0]?.path.includes("good")).toBe(true)
  expect(result[0]?.path.endsWith("SKILL.md")).toBe(true)
})

test("readAgentsCatalog defaults name to id and description to empty string", () => {
  const result = readAgentsCatalog("/proj", {
    readDir: (): string[] => ["plain"],
    readFile: (): string => "# body without frontmatter\n",
  })
  expect(result).toHaveLength(1)
  expect(result[0]?.id).toBe("plain")
  expect(result[0]?.name).toBe("plain")
  expect(result[0]?.description).toBe("")
})

test("readAgentsCatalog reads real SKILL.md files from a tmpdir", () => {
  const dir = mkdtempSync(join(tmpdir(), "omo-skills-"))
  try {
    const skillDir = join(dir, ".agents", "skills", "demo")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: demo desc\n---\n# demo\n",
    )
    mkdirSync(join(dir, ".agents", "skills", "noskill"), { recursive: true })
    const catalog = readAgentsCatalog(dir)
    expect(catalog).toHaveLength(1)
    expect(catalog[0]?.id).toBe("demo")
    expect(catalog[0]?.name).toBe("demo-skill")
    expect(catalog[0]?.description).toBe("demo desc")
    expect(catalog[0]?.path).toBe(join(skillDir, "SKILL.md"))
    expect(readAgentsCatalog(join(dir, "missing"))).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
