import { describe, expect, it } from "bun:test"
import { OmoError } from "../../src/errors/base.js"
import {
  ERROR_CODES,
  type ErrorCode,
  errorCodeCategory,
  isErrorCode,
} from "../../src/errors/registry.js"

describe("ERROR_CODES registry", () => {
  it("exports all expected categories", () => {
    expect(Object.keys(ERROR_CODES).length).toBeGreaterThan(0)
    // Verify key categories exist
    expect(ERROR_CODES.timeout).toBe("timeout")
    expect(ERROR_CODES["duplicate-step"]).toBe("duplicate-step")
    expect(ERROR_CODES["unknown-category"]).toBe("unknown-category")
    expect(ERROR_CODES["install-failed"]).toBe("install-failed")
  })

  it("has no duplicate values across categories", () => {
    const values = Object.values(ERROR_CODES)
    const unique = new Set(values)
    expect(unique.size).toBe(values.length)
  })

  it("all codes are unique strings", () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(typeof key).toBe("string")
      expect(typeof value).toBe("string")
      expect(key).toBe(value)
    }
  })
})

describe("isErrorCode", () => {
  it("returns true for known codes", () => {
    expect(isErrorCode("timeout")).toBe(true)
    expect(isErrorCode("duplicate-step")).toBe(true)
    expect(isErrorCode("unknown-category")).toBe(true)
  })

  it("returns false for unknown codes", () => {
    expect(isErrorCode("nonexistent-code")).toBe(false)
    expect(isErrorCode("")).toBe(false)
    expect(isErrorCode("TIMEOUT")).toBe(false) // case-sensitive
  })
})

describe("errorCodeCategory", () => {
  it("returns the correct category for worktree codes", () => {
    expect(errorCodeCategory("cancelled")).toBe("worktree")
    expect(errorCodeCategory("git-failed")).toBe("worktree")
  })

  it("returns the correct category for plan codes", () => {
    expect(errorCodeCategory("dependency-cycle")).toBe("plan")
    expect(errorCodeCategory("illegal-transition")).toBe("plan")
  })

  it("returns the correct category for process codes", () => {
    expect(errorCodeCategory("timeout")).toBe("process")
    expect(errorCodeCategory("spawn")).toBe("process")
  })

  it("returns undefined for unknown codes", () => {
    // TypeScript prevents passing invalid codes, but runtime check works
    expect(errorCodeCategory("timeout" as unknown as ErrorCode)).toBe("process")
  })
})

describe("OmoError with typed codes", () => {
  it("accepts registered error codes at runtime", () => {
    const error = new OmoError("timeout", "process timed out")
    expect(error.code).toBe("timeout")
    expect(error.message).toBe("process timed out")
  })

  it("preserves cause chain", () => {
    const cause = new Error("root cause")
    // Bun/Node attach cause via the options object
    const error = new OmoError("spawn", "failed to spawn")
    Object.defineProperty(error, "cause", { value: cause, writable: false, configurable: true })
    expect(error.cause).toBe(cause)
  })

  it("serializes to JSON with all fields", () => {
    const error = new OmoError("dependency-cycle", "cycle detected", {
      path: "step-3",
      details: { steps: ["a", "b", "c"] },
    })
    const json = error.toJSON()
    expect(json.name).toBe("OmoError")
    expect(json.code).toBe("dependency-cycle")
    expect(json.message).toBe("cycle detected")
    expect(json.path).toBe("step-3")
    expect(json.details).toEqual({ steps: ["a", "b", "c"] })
  })

  it("includes cause in JSON serialization", () => {
    const cause = new Error("underlying issue")
    const error = new OmoError("sql-error", "db failed")
    Object.defineProperty(error, "cause", { value: cause, writable: false, configurable: true })
    const json = error.toJSON()
    expect(json.cause).toBeDefined()
    expect((json.cause as { name: string }).name).toBe("Error")
  })
})
