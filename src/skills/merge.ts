import type { FilesystemSkill } from "./catalog.js"

export type HostSkillEntry = {
  id: string
  name: string
  description?: string
}

export function mergeCatalogs(
  host: readonly HostSkillEntry[],
  fs: readonly FilesystemSkill[],
): { catalog: HostSkillEntry[]; origins: Map<string, "host" | "fs" | "both"> } {
  const catalog: HostSkillEntry[] = []
  const origins = new Map<string, "host" | "fs" | "both">()
  const byId = new Map<string, number>()
  const byName = new Map<string, number>()

  const claim = (index: number, id: string, name: string): void => {
    const idKey = id.toLowerCase()
    const nameKey = name.toLowerCase()
    if (!byId.has(idKey)) byId.set(idKey, index)
    if (!byName.has(nameKey)) byName.set(nameKey, index)
  }

  const find = (id: string, name: string): number | undefined =>
    byId.get(id.toLowerCase()) ?? byName.get(name.toLowerCase())

  for (const entry of host) {
    if (find(entry.id, entry.name) !== undefined) continue
    const index = catalog.length
    catalog.push({ ...entry })
    origins.set(entry.id, "host")
    claim(index, entry.id, entry.name)
  }

  for (const entry of fs) {
    const existing = find(entry.id, entry.name)
    if (existing !== undefined) {
      origins.set(catalog[existing]?.id ?? entry.id, "both")
      continue
    }
    const index = catalog.length
    const mapped: HostSkillEntry = {
      id: entry.id,
      name: entry.name,
      description: entry.description,
    }
    catalog.push(mapped)
    origins.set(mapped.id, "fs")
    claim(index, mapped.id, mapped.name)
  }

  return { catalog, origins }
}
