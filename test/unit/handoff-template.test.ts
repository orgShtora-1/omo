import { describe, expect, test } from "bun:test"
import type { HandoffArgs } from "../../src/handoff/args"
import { renderHandoffTemplate } from "../../src/handoff/commands"
import { HANDOFF_TEMPLATE } from "../../src/handoff/template"

const base: HandoffArgs = { to: "session", focus: "", root: "/repo" }

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: this file asserts on the literal
// placeholder text the renderer consumes, so it must stay a plain string.
describe("renderHandoffTemplate", () => {
  test("every declared placeholder is substituted", () => {
    const placeholders = [...HANDOFF_TEMPLATE.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1])
    expect([...new Set(placeholders)].sort()).toEqual(["root", "sessionID", "to"])
    const out = renderHandoffTemplate(base, "ses_1")
    for (const name of ["root", "sessionID", "to"]) expect(out).not.toContain(`\${${name}}`)
  })

  test("the session id reaches the body", () => {
    expect(renderHandoffTemplate(base, "ses_abc123")).toContain("ses_abc123")
  })

  test("the next-task heading appears only when there is focus", () => {
    expect(renderHandoffTemplate(base, "ses_1")).not.toContain("## Next task (honor these)")
    expect(renderHandoffTemplate({ ...base, focus: "finish the fix" }, "ses_1")).toContain(
      "## Next task (honor these)\n\nfinish the fix",
    )
  })

  test("both destinations are documented with their own contract", () => {
    for (const heading of ["## Mode: session", "## Mode: agent"])
      expect(HANDOFF_TEMPLATE).toContain(heading)
  })

  test("the session block keeps the prescribed section order", () => {
    const order = [
      "USER REQUESTS (AS-IS)",
      "GOAL",
      "WORK COMPLETED",
      "CURRENT STATE",
      "PENDING TASKS",
      "KEY FILES",
      "IMPORTANT DECISIONS",
      "EXPLICIT CONSTRAINTS",
      "CONTEXT FOR CONTINUATION",
    ]
    const body = HANDOFF_TEMPLATE.slice(HANDOFF_TEMPLATE.indexOf("USER REQUESTS (AS-IS)"))
    let cursor = 0
    for (const section of order) {
      const at = body.indexOf(section, cursor)
      expect(at).toBeGreaterThanOrEqual(0)
      cursor = at
    }
  })

  test("the do-not-reconstruct-from-memory mandate survives", () => {
    for (const mandate of [
      "Do not reconstruct the original request from memory",
      "Do not paraphrase",
      "If the read fails or returns no user messages, state that plainly",
      "ten** files in KEY FILES",
    ])
      expect(HANDOFF_TEMPLATE).toContain(mandate)
  })

  test("agent mode points at the existing contract rather than inventing one", () => {
    expect(HANDOFF_TEMPLATE).toContain("contract is fixed in code")
    expect(HANDOFF_TEMPLATE).toContain("omo_delegate")
    expect(HANDOFF_TEMPLATE).toContain("exitCriteria")
    expect(HANDOFF_TEMPLATE).toContain("12000")
  })

  test("rendered output is trimmed at both ends", () => {
    const out = renderHandoffTemplate(base, "ses_1")
    expect(out).toBe(out.trim())
    expect(out.startsWith("# Handoff Command")).toBe(true)
  })
})
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see the note above.
