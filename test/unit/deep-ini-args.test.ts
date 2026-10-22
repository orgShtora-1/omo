import { describe, expect, test } from "bun:test"
import { DEFAULT_MAX_DEPTH, MAX_DEPTH_CEILING, parseDeepIniArgs } from "../../src/deepini/args"

const PROJECT = "/repo"

describe("parseDeepIniArgs", () => {
  test("defaults to update mode at depth 3 rooted at the project", () => {
    expect(parseDeepIniArgs("", PROJECT)).toEqual({
      mode: "update",
      maxDepth: DEFAULT_MAX_DEPTH,
      root: PROJECT,
      focus: "",
    })
  })

  test.each([
    ["--update", "update"],
    ["--create-new", "create-new"],
    ["--dry-run", "dry-run"],
  ] as const)("%s selects mode %s", (flag, mode) => {
    expect(parseDeepIniArgs(flag, PROJECT).mode).toBe(mode)
  })

  test("the last mode flag wins, so a pasted command line is unambiguous", () => {
    expect(parseDeepIniArgs("--create-new --update", PROJECT).mode).toBe("update")
    expect(parseDeepIniArgs("--update --create-new", PROJECT).mode).toBe("create-new")
  })

  test.each([1, 2, 3, 4, 5, MAX_DEPTH_CEILING])("accepts --max-depth=%i", (depth) => {
    expect(parseDeepIniArgs(`--max-depth=${depth}`, PROJECT).maxDepth).toBe(depth)
  })

  test.each([
    "--max-depth=0",
    "--max-depth=7",
    "--max-depth=-1",
    "--max-depth=abc",
    `--max-depth=${MAX_DEPTH_CEILING + 1}`,
  ])("rejects %s rather than letting the model improvise a depth", (flag) => {
    expect(() => parseDeepIniArgs(flag, PROJECT)).toThrow("--max-depth")
  })

  test("--root overrides the project root", () => {
    expect(parseDeepIniArgs("--root=/other", PROJECT).root).toBe("/other")
  })

  test("--root with an empty value is rejected, not treated as unset", () => {
    expect(() => parseDeepIniArgs("--root=", PROJECT)).toThrow("--root requires a non-empty path")
    expect(() => parseDeepIniArgs("--root=   ", PROJECT)).toThrow(
      "--root requires a non-empty path",
    )
  })

  test("unknown tokens become free focus text, order preserved", () => {
    const args = parseDeepIniArgs("focus on the auth layer", PROJECT)
    expect(args.focus).toBe("focus on the auth layer")
  })

  test("flags and focus mix without leaking flags into the focus", () => {
    const args = parseDeepIniArgs("--create-new --max-depth=2 --root=/proj only the api", PROJECT)
    expect(args).toEqual({
      mode: "create-new",
      maxDepth: 2,
      root: "/proj",
      focus: "only the api",
    })
  })

  test("whitespace-only input is not mistaken for focus", () => {
    expect(parseDeepIniArgs("   \n\t ", PROJECT).focus).toBe("")
  })
})
