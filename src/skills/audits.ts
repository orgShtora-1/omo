export type AuditVerdict = "pass" | "warn" | "fail" | "unknown"

export function summarizeAudits(body: unknown): AuditVerdict {
  if (typeof body !== "object" || body === null) return "unknown"
  const audits = (body as { audits?: unknown }).audits
  if (!Array.isArray(audits) || audits.length === 0) return "unknown"
  let seenWarn = false
  for (const entry of audits) {
    if (typeof entry !== "object" || entry === null) continue
    const status = (entry as { status?: unknown }).status
    if (status === "fail") return "fail"
    if (status === "warn") seenWarn = true
  }
  return seenWarn ? "warn" : "pass"
}

const SKILL_ID_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/

export async function fetchSkillAudits(
  skillId: string,
  fetchFn: typeof fetch,
  baseUrl = "https://skills.sh",
): Promise<{ verdict: AuditVerdict; audits: unknown[] }> {
  if (!SKILL_ID_PATTERN.test(skillId)) throw new Error(`invalid skill id: ${skillId}`)
  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/skills/audit/${skillId}`
  const response = await fetchFn(url)
  if (response.status === 404) return { verdict: "unknown", audits: [] }
  if (!response.ok) throw new Error(`skill audit request failed: ${response.status}`)
  const body: unknown = await response.json()
  const audits =
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { audits?: unknown }).audits)
      ? (body as { audits: unknown[] }).audits
      : []
  return { verdict: summarizeAudits(body), audits }
}
