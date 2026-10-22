import { expect, test } from "bun:test"
import type { FilesystemSkill } from "../../src/skills/catalog.js"
import { type HostSkillEntry, mergeCatalogs } from "../../src/skills/merge.js"

const fsSkill = (id: string, name: string, description: string): FilesystemSkill => ({
  id,
  name,
  description,
  path: `/skills/${id}/SKILL.md`,
})

test("host entries win conflicts and record both origins", () => {
  const host: HostSkillEntry[] = [{ id: "a", name: "Host Name", description: "host desc" }]
  const { catalog, origins } = mergeCatalogs(host, [fsSkill("a", "Fs Name", "fs desc")])
  expect(catalog).toEqual([{ id: "a", name: "Host Name", description: "host desc" }])
  expect(origins.get("a")).toBe("both")
})

test("filesystem entries fill gaps with fs origins", () => {
  const { catalog, origins } = mergeCatalogs(
    [{ id: "h", name: "Host Only" }],
    [fsSkill("f", "Fs Only", "from disk")],
  )
  expect(catalog).toEqual([
    { id: "h", name: "Host Only" },
    { id: "f", name: "Fs Only", description: "from disk" },
  ])
  expect(origins.get("h")).toBe("host")
  expect(origins.get("f")).toBe("fs")
})

test("dedupe matches ids case-insensitively with host winning", () => {
  const { catalog, origins } = mergeCatalogs(
    [{ id: "Skill:A", name: "Alpha" }],
    [fsSkill("skill:a", "alpha-fs", "fs desc")],
  )
  expect(catalog).toHaveLength(1)
  expect(catalog[0]).toEqual({ id: "Skill:A", name: "Alpha" })
  expect(origins.get("Skill:A")).toBe("both")
})

test("dedupe matches names case-insensitively across different ids", () => {
  const { catalog, origins } = mergeCatalogs(
    [{ id: "h1", name: "Review" }],
    [fsSkill("f1", "review", "fs desc")],
  )
  expect(catalog).toHaveLength(1)
  expect(catalog[0]?.id).toBe("h1")
  expect(origins.get("h1")).toBe("both")
  expect(origins.has("f1")).toBe(false)
})
