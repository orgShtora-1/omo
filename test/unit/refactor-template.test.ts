import { describe, expect, test } from "bun:test"
import type { RefactorArgs } from "../../src/refactor/args"
import { renderRefactorTemplate } from "../../src/refactor/commands"
import { REFACTOR_TEMPLATE } from "../../src/refactor/template"

const base: RefactorArgs = {
  target: "src/memory/commit.ts",
  scope: "module",
  strategy: "safe",
  focus: "",
  root: "/repo",
}

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: these assertions are about the
// literal placeholder text that the renderer consumes, so it must stay a plain string.
describe("renderRefactorTemplate", () => {
  test("every declared placeholder is substituted", () => {
    const placeholders = [...REFACTOR_TEMPLATE.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1])
    expect([...new Set(placeholders)].sort()).toEqual(["root", "scope", "strategy", "target"])
    const out = renderRefactorTemplate(base)
    for (const name of ["root", "scope", "strategy", "target"])
      expect(out).not.toContain(`\${${name}}`)
  })

  test("an unknown placeholder survives verbatim instead of rendering empty", () => {
    const out = renderRefactorTemplate(base, "root=${root} typo=${rooot}")
    expect(out).toContain("root=/repo")
    expect(out).toContain("typo=${rooot}")
  })

  test("the focus heading appears only when there is focus", () => {
    expect(renderRefactorTemplate(base)).not.toContain("## User focus (honor these)")
    expect(renderRefactorTemplate({ ...base, focus: "keep the API" })).toContain(
      "## User focus (honor these)\n\nkeep the API",
    )
  })

  test("the body is self-contained and keeps every phase", () => {
    for (const heading of [
      "# Intelligent Refactor Command",
      "## Non-negotiable grounding mandate",
      "## Phase 0: Intent gate",
      "## Phase 1: Codebase analysis",
      "## Phase 2: Codemap",
      "## Phase 3: Test coverage gate",
      "## Phase 4: Plan",
      "## Phase 5: Execute",
      "## Phase 6: Final verification",
    ])
      expect(REFACTOR_TEMPLATE).toContain(heading)
  })

  test("the safety mandates that the algorithm depends on are present", () => {
    for (const mandate of [
      "Never continue to the next step with failing tests",
      "Never silence an error with `any`, a suppression comment, or an unchecked cast",
      "Post-step verification. Mandatory, every step",
      "Fire all five background explorers in ONE batch",
      "HIGH, above 80%",
      "## Never",
      "## Abort immediately when",
    ])
      expect(REFACTOR_TEMPLATE).toContain(mandate)
  })

  test("tool names are rewritten to this plugin and to OpenCode V2", () => {
    for (const tool of [
      "omo_lsp_references",
      "omo_lsp_diagnostics",
      "omo_lsp_prepare_rename",
      "omo_delegate",
      "omo_parallel",
      "omo_worktree",
      "ast-grep",
    ])
      expect(REFACTOR_TEMPLATE).toContain(tool)
    // Upstream Claude-tool names must not survive the vocabulary rewrite.
    for (const stale of [
      "LspGotoDefinition",
      "LspFindReferences",
      "Task(subagent_type",
      "background_output",
    ])
      expect(REFACTOR_TEMPLATE).not.toContain(stale)
  })

  test("rendered output is trimmed at both ends", () => {
    const out = renderRefactorTemplate(base)
    expect(out).toBe(out.trim())
    expect(out.startsWith("# Intelligent Refactor Command")).toBe(true)
  })
})
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see the note above.
