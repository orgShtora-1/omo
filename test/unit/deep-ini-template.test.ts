import { describe, expect, test } from "bun:test"
import { parseDeepIniArgs } from "../../src/deepini/args"
import { renderDeepIniTemplate } from "../../src/deepini/commands"
import { DEEP_INI_TEMPLATE } from "../../src/deepini/template"

function render(input: string): string {
  return renderDeepIniTemplate(parseDeepIniArgs(input, "/repo"))
}

describe("deep-ini template", () => {
  test("every placeholder is substituted", () => {
    const out = render("--create-new --max-depth=2 --root=/proj")
    expect(out).not.toContain("${")
  })

  test("root, mode and maxDepth land in the body", () => {
    const out = render("--dry-run --max-depth=5 --root=/proj")
    expect(out).toContain("/proj")
    expect(out).toContain("dry-run")
    expect(out).toContain("5")
  })

  test("the template declares exactly the three placeholders the renderer knows", () => {
    const declared = [...new Set(DEEP_INI_TEMPLATE.match(/\$\{\w+\}/g) ?? [])].sort()
    // The literals below are the point: these must stay plain strings, because a
    // template string would interpolate them away before the assertion ever runs.
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: asserting on literal placeholder text
    expect(declared).toEqual(["${maxDepth}", "${mode}", "${root}"])
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: asserting on literal placeholder text
  })

  test("an unknown placeholder is left verbatim instead of rendering empty", () => {
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: literal placeholders under test
    const out = renderDeepIniTemplate(
      { mode: "update", maxDepth: 3, root: "/repo", focus: "" },
      "root=${root} typo=${rooot} other=${nope}",
    )
    expect(out).toBe("root=/repo typo=${rooot} other=${nope}")
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: literal placeholders under test
  })

  test("focus is appended under its own heading, and only when present", () => {
    expect(render("focus on src")).toContain("## User focus (honor these)\n\nfocus on src")
    expect(render("")).not.toContain("## User focus")
  })

  test("the rendered body is the durable user message, so it must be self-contained", () => {
    const out = render("")
    const firstLine = out.split("\n")[0] ?? ""
    expect(firstLine).toMatch(/AGENTS\.md/)
    expect(out).toContain("Track all five phases")
    expect(out).toContain("AGENTS_LOCATIONS")
    expect(out).toContain("deep-ini Complete")
  })

  test("the grounding mandate and the never-overwrite rule survive generation", () => {
    const out = render("")
    expect(out).toContain("## Non-negotiable grounding mandate")
    expect(out).toContain("- file already exists -> edit it in place")
    expect(out).toContain("- file does not exist -> create it")
    expect(out).toContain("- never write over an existing file wholesale")
  })

  test("the fan-out formula is present so the model sizes its own fan-out", () => {
    expect(DEEP_INI_TEMPLATE).toContain("+ floor(total_files / 100)")
    expect(DEEP_INI_TEMPLATE).toContain("+ floor(total_lines / 10000)")
  })

  test("concurrent background fan-out is mandated, not merely suggested", () => {
    const out = render("")
    expect(out).toContain("Launch the exploration agents in ONE batch, in the background")
    expect(out).toContain("sequential exploration instead of concurrent background fan-out")
  })

  test("size gates match the documented limits", () => {
    const out = render("")
    expect(out).toContain("### Root file, 50 to 150 lines")
    expect(out).toContain("### Subdirectory file, 30 to 80 lines")
  })

  test("the template is trimmed on both ends, not padded with blank lines", () => {
    const out = render("")
    expect(out).toBe(out.trim())
  })
})
