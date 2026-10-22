import { expect, test } from "bun:test"
import { scoreSkills, selectSkills } from "../../src/delegation/skills.js"

test.each(["explicit", "required"] as const)(
  "unknown %s skill produces an actionable error",
  (source) => {
    expect(() =>
      selectSkills(
        source === "explicit" ? ["missing"] : [],
        source === "required" ? ["missing"] : [],
        [],
        [],
      ),
    ).toThrow(`${source} skill not found: missing`)
  },
)

test("explicit and required skills survive the recommendation cap with canonical deduplication", () => {
  const catalog = [
    { id: "skill:test", name: "testing" },
    { id: "skill:review", name: "review" },
    { id: "skill:docs", name: "docs" },
    { id: "skill:style", name: "style" },
  ]
  expect(
    selectSkills(["testing", "skill:test"], ["review"], ["testing", "docs", "style"], catalog, 1),
  ).toEqual(["skill:test", "skill:review", "skill:docs"])
})

const scoringCatalog = [
  { id: "skill:review", name: "code-review", description: "reviews correctness and regressions" },
  {
    id: "skill:docs",
    name: "docs-writer",
    description: "writes documentation pages and release notes",
  },
  { id: "skill:noise", name: "xqy-helper", description: "assists with chores" },
]

test("a name-token hit outranks description-only matches", () => {
  const ranked = scoreSkills("review this change for correctness", "review", scoringCatalog)
  expect(ranked[0]?.id).toBe("skill:review")
  expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0)
})

test("route affinity surfaces task-kind skills from bare prompts", () => {
  const ranked = scoreSkills("please take a look", "review", scoringCatalog)
  expect(ranked.map((entry) => entry.id)).toContain("skill:review")
})

test("kebab-case names tokenize and description noise stays below threshold", () => {
  const ranked = scoreSkills("write release notes for the docs", "document", scoringCatalog)
  expect(ranked.map((entry) => entry.id)).toContain("skill:docs")
  expect(ranked.map((entry) => entry.id)).not.toContain("skill:noise")
  expect(scoreSkills("fix chores quickly", "implement", scoringCatalog)).toEqual([])
})

test("ties break deterministically by skill id", () => {
  const ranked = scoreSkills("review", "review", [
    { id: "skill:b", name: "review-b" },
    { id: "skill:a", name: "review-a" },
  ])
  expect(ranked.map((entry) => entry.id)).toEqual(["skill:a", "skill:b"])
})

test("long descriptions cannot recommend an unrelated skill without a name or route match", () => {
  expect(
    scoreSkills("inspect plugin runtime tests and compatibility", "implement", [
      {
        id: "skill:unrelated",
        name: "xqy-helper",
        description: "inspect plugin runtime tests and compatibility",
      },
      { id: "skill:plugin", name: "plugin-testing", description: "plugin runtime tests" },
    ]).map((entry) => entry.id),
  ).toEqual(["skill:plugin"])
})
