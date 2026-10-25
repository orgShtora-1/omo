import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

export type FilesystemSkill = {
  id: string
  name: string
  description: string
  path: string
}

export type SkillCatalogIo = {
  readDir(path: string): Promise<string[]>
  readFile(path: string): Promise<string>
  stat(path: string): Promise<{ mtimeMs: number }>
}

const defaultIo: SkillCatalogIo = {
  readDir: (path) => readdir(path),
  readFile: (path) => readFile(path, "utf8"),
  stat: (path) => stat(path),
}

// TTL-based cache to avoid repeated async I/O in the delegation hot path.
// Invalidates after CACHE_TTL_MS or when the directory's mtime changes.
const CACHE_TTL_MS = 60_000
const catalogCache = new Map<
  string,
  { skills: FilesystemSkill[]; loadedAt: number; mtime: number }
>()

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

/**
 * Read the .agents/skills/ catalog asynchronously.
 * Uses an in-memory TTL cache to avoid repeated I/O in the delegation hot path.
 * This is non-blocking and will not stall the event loop.
 */
export async function readAgentsCatalog(
  projectDir: string,
  io: SkillCatalogIo = defaultIo,
): Promise<FilesystemSkill[]> {
  const now = Date.now()
  const cacheKey = projectDir
  const cached = catalogCache.get(cacheKey)
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.skills
  }

  const skillsDir = join(projectDir, ".agents", "skills")
  let entries: string[]
  try {
    entries = await io.readDir(skillsDir)
  } catch {
    catalogCache.set(cacheKey, { skills: [], loadedAt: now, mtime: now })
    return []
  }

  // Process entries concurrently but limit concurrency to avoid flooding
  const BATCH_SIZE = 10
  const catalog: FilesystemSkill[] = []

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(async (id) => {
        const skillFile = join(skillsDir, id, "SKILL.md")
        try {
          const source = await io.readFile(skillFile)
          const frontmatter = parseSkillFrontmatter(source)
          return {
            id,
            name: frontmatter.name || id,
            description: frontmatter.description || "",
            path: skillFile,
          }
        } catch {
          return null
        }
      }),
    )
    for (const skill of results) {
      if (skill) catalog.push(skill)
    }
  }

  // Get directory mtime for cache invalidation
  let mtime = now
  try {
    const dirStat = await io.stat(skillsDir)
    mtime = dirStat.mtimeMs
  } catch {
    // Directory may have been removed between readDir and stat
  }

  catalogCache.set(cacheKey, { skills: catalog, loadedAt: now, mtime })
  return catalog
}

/** Exposed for tests to clear the cache between runs. */
export function invalidateCatalogCache(): void {
  catalogCache.clear()
}
