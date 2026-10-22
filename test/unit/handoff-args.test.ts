import { describe, expect, test } from "bun:test"
import { HANDOFF_MODES, parseHandoffArgs } from "../../src/handoff/args"

describe("parseHandoffArgs", () => {
  test("defaults to a session handoff", () => {
    const args = parseHandoffArgs("", "/repo")
    expect(args.to).toBe("session")
    expect(args.root).toBe("/repo")
    expect(args.focus).toBe("")
  })

  test.each([...HANDOFF_MODES])("accepts --to=%s", (mode) => {
    expect(parseHandoffArgs(`--to=${mode}`, "/repo").to).toBe(mode)
  })

  test("rejects an unknown destination rather than guessing", () => {
    expect(() => parseHandoffArgs("--to=team", "/repo")).toThrow(
      "--to must be one of: session, agent",
    )
  })

  test("a bare --to is an explicit error, not a silent default", () => {
    expect(() => parseHandoffArgs("--to", "/repo")).toThrow(
      "--to needs a value, for example --to=agent",
    )
  })

  test("unflagged text is the next task", () => {
    const args = parseHandoffArgs("finish the commit recovery fix", "/repo")
    expect(args.to).toBe("session")
    expect(args.focus).toBe("finish the commit recovery fix")
  })

  test("the flag may appear after the focus", () => {
    const args = parseHandoffArgs("finish the fix --to=agent", "/repo")
    expect(args.to).toBe("agent")
    expect(args.focus).toBe("finish the fix")
  })

  test("whitespace-only input still yields a complete set of arguments", () => {
    const args = parseHandoffArgs("  \t ", "/repo")
    expect(args.to).toBe("session")
    expect(args.focus).toBe("")
  })
})
