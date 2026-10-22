import type { PackageManager } from "../config/schema.js"
import { type SkillCatalogEntry, scoreSkills } from "../delegation/skills.js"
import type { AuditVerdict } from "./audits.js"
import { fetchSkillAudits } from "./audits.js"
import { installSkill } from "./installer.js"

type SkillSearchHit = { source: string; slug: string }

type InstalledSkillOutcome = "installed" | "refused-audit" | "install-failed" | "search-empty"

type InstalledSkill = { id: string; source: string; outcome: InstalledSkillOutcome }

export type EnsureSkillCoverageInput = {
  prompt: string
  routeID: string
  merged: readonly SkillCatalogEntry[]
  hostIds: readonly string[]
  autoInstall: boolean
  requireAuditPass: boolean
  /**
   * Strict audit policy: with the audit guard on, only a `pass` verdict may
   * install. Default resolution is false, preserving the historical tolerance
   * of `warn`/`unknown`.
   */
  strictAudits: boolean
  /** Package manager for the default install path; forwarded from `runtime.packageManager`. */
  packageManager?: PackageManager
  search?: (query: string, limit: number) => Promise<SkillSearchHit[]>
  getAudits?: (skillId: string) => Promise<{ verdict: AuditVerdict; audits: unknown[] }>
  install?: (input: { source: string; slug: string }) => Promise<"installed" | "install-failed">
}

export type EnsureSkillCoverageResult = { installedSkills: InstalledSkill[]; note?: string }

const SEARCH_URL = "https://skills.sh/api/search"

function toHit(raw: unknown): SkillSearchHit | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const entry = raw as Record<string, unknown>
  const source = typeof entry.source === "string" ? entry.source.trim() : ""
  const slug =
    typeof entry.slug === "string" && entry.slug.trim() !== ""
      ? entry.slug.trim()
      : typeof entry.skillId === "string" && entry.skillId.trim() !== ""
        ? entry.skillId.trim()
        : typeof entry.name === "string" && entry.name.trim() !== ""
          ? entry.name.trim()
          : ""
  if (source !== "" && slug !== "") return { source, slug }
  // Tolerate bare `id` shapes: "owner/repo/slug" (preferred) or "owner/slug".
  if (typeof entry.id === "string") {
    const parts = entry.id.split("/").filter((part) => part !== "")
    if (parts.length >= 3) {
      const slugPart = parts.at(-1) ?? ""
      const sourcePart = parts.slice(0, -1).join("/")
      if (sourcePart !== "" && slugPart !== "") return { source: sourcePart, slug: slugPart }
    } else if (parts.length === 2) {
      const [owner, name] = parts as [string, string]
      if (owner !== "" && name !== "") return { source: owner, slug: name }
    }
  }
  return undefined
}

function mapSearchHits(body: unknown): SkillSearchHit[] {
  const list: unknown = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null
      ? ((body as Record<string, unknown>).skills ??
        (body as Record<string, unknown>).items ??
        (body as Record<string, unknown>).results ??
        [])
      : []
  if (!Array.isArray(list)) return []
  const hits: SkillSearchHit[] = []
  for (const raw of list) {
    const hit = toHit(raw)
    if (hit) hits.push(hit)
  }
  return hits
}

/** Live skills.sh search. Verified 2026-10-11 via
 * `curl 'https://skills.sh/api/search?q=triage&limit=2'`: `{ skills:
 * [{ id: "inference-sh/skills/ai-video-generation", source:
 * "inference-sh/skills", skillId: "ai-video-generation", name:
 * "ai-video-generation", ... }] }`. Mapping accepts that shape plus bare
 * `{id}` or `{source,slug}` items; anything else is skipped. */
async function searchSkillsSh(query: string, limit: number): Promise<SkillSearchHit[]> {
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${limit}`
  const response = await fetch(url)
  if (!response.ok) return []
  const body: unknown = await response.json()
  return mapSearchHits(body)
}

export async function ensureSkillCoverage(
  input: EnsureSkillCoverageInput,
): Promise<EnsureSkillCoverageResult> {
  try {
    void input.hostIds
    if (scoreSkills(input.prompt, input.routeID, input.merged).length > 0)
      return { installedSkills: [] }
    if (!input.autoInstall) return { installedSkills: [], note: "auto-install disabled" }
    const search = input.search ?? searchSkillsSh
    let hits: SkillSearchHit[]
    try {
      hits = await search(input.prompt, 3)
    } catch {
      hits = []
    }
    const top = hits[0]
    if (!top)
      return {
        installedSkills: [{ id: input.prompt, source: "skills.sh", outcome: "search-empty" }],
      }
    const getAudits = input.getAudits ?? ((skillId: string) => fetchSkillAudits(skillId, fetch))
    let verdict: AuditVerdict = "unknown"
    try {
      verdict = (await getAudits(`${top.source}/${top.slug}`)).verdict
    } catch {
      verdict = "unknown"
    }
    if (
      input.requireAuditPass &&
      (verdict === "fail" || (input.strictAudits && verdict !== "pass"))
    )
      return { installedSkills: [{ id: top.slug, source: top.source, outcome: "refused-audit" }] }
    const install =
      input.install ??
      ((hit) => installSkill({ ...hit, cwd: process.cwd(), packageManager: input.packageManager }))
    let outcome: "installed" | "install-failed"
    try {
      outcome = await install({ source: top.source, slug: top.slug })
    } catch {
      outcome = "install-failed"
    }
    return { installedSkills: [{ id: top.slug, source: top.source, outcome }] }
  } catch {
    return {
      installedSkills: [{ id: input.prompt, source: "skills.sh", outcome: "install-failed" }],
    }
  }
}
