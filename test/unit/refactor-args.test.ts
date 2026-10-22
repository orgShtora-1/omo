import { describe, expect, test } from "bun:test"
import { parseRefactorArgs, REFACTOR_SCOPES, REFACTOR_STRATEGIES } from "../../src/refactor/args"

describe("parseRefactorArgs", () => {
  test("defaults to a safe module-scoped refactor with no target", () => {
    const args = parseRefactorArgs("", "/repo")
    expect(args.scope).toBe("module")
    expect(args.strategy).toBe("safe")
    expect(args.root).toBe("/repo")
    expect(args.focus).toBe("")
    // A bare /refactor must never silently read as "refactor everything".
    expect(args.target).toContain("UNSPECIFIED")
    expect(args.target).toContain("intent gate")
  })

  test("the first bare token is the target and the rest is focus", () => {
    const args = parseRefactorArgs("src/memory/commit.ts keep the exported API stable", "/repo")
    expect(args.target).toBe("src/memory/commit.ts")
    expect(args.focus).toBe("keep the exported API stable")
  })

  test.each([...REFACTOR_SCOPES])("accepts --scope=%s", (scope) => {
    expect(parseRefactorArgs(`--scope=${scope} target`, "/repo").scope).toBe(scope)
  })

  test.each([...REFACTOR_STRATEGIES])("accepts --strategy=%s", (strategy) => {
    expect(parseRefactorArgs(`--strategy=${strategy} target`, "/repo").strategy).toBe(strategy)
  })

  test("rejects an unknown scope instead of falling back", () => {
    expect(() => parseRefactorArgs("--scope=galaxy target", "/repo")).toThrow(
      "--scope must be one of: file, module, project",
    )
  })

  test("rejects an unknown strategy instead of falling back", () => {
    expect(() => parseRefactorArgs("--strategy=yolo target", "/repo")).toThrow(
      "--strategy must be one of: safe, aggressive",
    )
  })

  test("a valueless flag is an explicit error, not a silent default", () => {
    expect(() => parseRefactorArgs("--scope target", "/repo")).toThrow(
      "--scope needs a value, for example --scope=file",
    )
    expect(() => parseRefactorArgs("--strategy", "/repo")).toThrow(
      "--strategy needs a value, for example --strategy=safe",
    )
  })

  test("flags may appear before, after, or between the target and the focus", () => {
    const before = parseRefactorArgs("--scope=file --strategy=aggressive src/a.ts tidy", "/repo")
    const after = parseRefactorArgs("src/a.ts tidy --scope=file --strategy=aggressive", "/repo")
    expect(before.target).toBe("src/a.ts")
    expect(before.focus).toBe("tidy")
    expect(before.scope).toBe("file")
    expect(before.strategy).toBe("aggressive")
    expect(after).toEqual(before)
  })

  test("the last occurrence of a repeated flag wins", () => {
    expect(parseRefactorArgs("--scope=file --scope=project target", "/repo").scope).toBe("project")
  })

  test("whitespace-only input still yields a complete set of arguments", () => {
    const args = parseRefactorArgs("   \t  ", "/repo")
    expect(args.scope).toBe("module")
    expect(args.strategy).toBe("safe")
    expect(args.focus).toBe("")
  })
})
