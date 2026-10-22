import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type FilesystemSkill = {
  id: string
  name: string
  description: string
  path: string
}

export type SkillCatalogIo = {
  readDir(path: string): string[]
  readFile(path: string): string
}

const defaultIo: SkillCatalogIo = {
  readDir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
}

const stripQuotes = (value: string): string => {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const FRONTMATTER_KEY = /^\s*(name|description)\s*:\s*(.*?)\s*$/

export function parseSkillFrontmatter(source: string): { name?: string; description?: string } {
  const result: { name?: string; description?: string } = {}
  const lines = source.split("\n")
  if (lines[0]?.trim() !== "---") return result
  const rest = lines.slice(1)
  const closing = rest.findIndex((line) => line.trim() === "---")
  if (closing === -1) return result
  for (const line of rest.slice(0, closing)) {
    const match = FRONTMATTER_KEY.exec(line)
    if (!match) continue
    const value = stripQuotes(match[2] ?? "")
    if (value === "") continue
    if (match[1] === "name" && result.name === undefined) result.name = value
    if (match[1] === "description" && result.description === undefined) result.description = value
  }
  return result
}

export function readAgentsCatalog(
  projectDir: string,
  io: SkillCatalogIo = defaultIo,
): FilesystemSkill[] {
  const skillsDir = join(projectDir, ".agents", "skills")
  let entries: string[]
  try {
    entries = io.readDir(skillsDir)
  } catch {
    return []
  }
  const catalog: FilesystemSkill[] = []
  for (const id of entries) {
    const skillFile = join(skillsDir, id, "SKILL.md")
    let source: string
    try {
      source = io.readFile(skillFile)
    } catch {
      continue
    }
    const frontmatter = parseSkillFrontmatter(source)
    catalog.push({
      id,
      name: frontmatter.name || id,
      description: frontmatter.description || "",
      path: skillFile,
    })
  }
  return catalog
}
