import { OmoError } from "../errors/base.js"

export type SkillCatalogEntry = { id: string; name: string; description?: string }

export type ScoredSkill = { id: string; score: number; hits: string[] }

const tokenize = (value: string): string[] => value.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []

/** Rank host skills against a task. Name-token matches weigh 3x a description
 * match; a route token matching a name token adds task-kind affinity (+2), so a
 * bare "review this" prompt still surfaces review skills. Threshold 3 admits a
 * single name-token hit. A name/route hit is required: long descriptions cannot
 * accumulate enough generic words to recommend unrelated skills. */
export function scoreSkills(
  query: string,
  routeID: string,
  catalog: readonly SkillCatalogEntry[],
): ScoredSkill[] {
  const queryWords = new Set(tokenize(`${routeID} ${query}`))
  const routeWords = new Set(tokenize(routeID))
  return catalog
    .map((skill) => {
      const nameTokens = new Set(tokenize(skill.name))
      const descTokens = new Set(tokenize(skill.description ?? ""))
      const hits = new Set<string>()
      let score = 0
      let nameMatch = false
      for (const word of queryWords) {
        if (nameTokens.has(word)) {
          nameMatch = true
          score += 3
          hits.add(word)
        } else if (descTokens.has(word)) {
          score += 1
          hits.add(word)
        }
      }
      for (const word of routeWords) if (nameTokens.has(word)) score += 2
      return { id: skill.id, score: nameMatch ? score : 0, hits: [...hits] }
    })
    .filter((item) => item.score >= 3)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

class SkillSelectionError extends OmoError {
  constructor(
    readonly source: "explicit" | "required",
    readonly skill: string,
  ) {
    super("unknown-skill", `${source} skill not found: ${skill}`)
  }
}

export function selectSkills(
  requested: readonly string[],
  required: readonly string[],
  recommended: readonly string[],
  catalog: readonly SkillCatalogEntry[],
  recommendedLimit = 5,
): string[] {
  const selected = new Set<string>()
  const find = (value: string) =>
    catalog.find((entry) => entry.id === value) ?? catalog.find((entry) => entry.name === value)
  for (const [source, values] of [
    ["explicit", requested],
    ["required", required],
  ] as const) {
    for (const value of values) {
      const skill = find(value)
      if (!skill) throw new SkillSelectionError(source, value)
      selected.add(skill.id)
    }
  }
  let added = 0
  for (const value of recommended) {
    if (added >= recommendedLimit) break
    const skill = find(value)
    if (!skill || selected.has(skill.id)) continue
    selected.add(skill.id)
    added++
  }
  return [...selected]
}
