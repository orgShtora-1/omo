import { afterEach, describe, expect, it } from "bun:test"
import { OmoError } from "../../src/errors/base.js"
import {
  disableStructuredLogging,
  type ErrorLogEntry,
  enableStructuredLogging,
  logError,
  logInfo,
  logWarning,
} from "../../src/errors/logging.js"

describe("structured error logging", () => {
  let entries: ErrorLogEntry[]
  const flush = () => {
    entries = []
    enableStructuredLogging((entry) => entries.push(entry))
  }
  afterEach(() => disableStructuredLogging())

  it("logs OmoError with code, message and timestamp", () => {
    flush()
    const error = new OmoError("timeout", "child process timed out")
    const entry = logError(error)
    expect(entry.code).toBe("timeout")
    expect(entry.message).toBe("child process timed out")
    expect(entry.level).toBe("error")
    expect(typeof entry.timestamp).toBe("string")
    // Also captured in sink
    expect(entries).toHaveLength(1)
    expect(entries[0]?.code).toBe("timeout")
  })

  it("includes path and details when present", () => {
    flush()
    const error = new OmoError("dependency-cycle", "cycle in plan", {
      path: "step-3",
      details: { deps: ["a", "b"] },
    })
    logError(error)
    expect(entries[0]?.path).toBe("step-3")
    expect(entries[0]?.details).toEqual({ deps: ["a", "b"] })
  })

  it("captures cause chain up to 5 links", () => {
    flush()
    const root = new Error("root")
    const middle = new Error("middle")
    Object.defineProperty(middle, "cause", { value: root, writable: false, configurable: true })
    const top = new OmoError("spawn", "top")
    Object.defineProperty(top, "cause", { value: middle, writable: false, configurable: true })
    logError(top)
    expect(entries[0]?.cause).toContain("top")
    expect(entries[0]?.cause).toContain("middle")
    expect(entries[0]?.cause).toContain("root")
  })

  it("logs plain Error objects with fallback code", () => {
    flush()
    logError(new TypeError("bad type"))
    expect(entries[0]?.code).toBe("typeerror")
    expect(entries[0]?.message).toBe("bad type")
  })

  it("does not crash on null/undefined", () => {
    flush()
    expect(() => logError(null)).not.toThrow()
    expect(() => logError(undefined)).not.toThrow()
  })

  it("logWarning produces a warn-level entry", () => {
    flush()
    const entry = logWarning("disk space low", { usedPct: 92 })
    expect(entry.level).toBe("warn")
    expect(entry.code).toBe("warning")
    expect(entry.details).toEqual({ usedPct: 92 })
  })

  it("logInfo produces an info-level entry", () => {
    flush()
    const entry = logInfo("plugin mounted", { version: "0.1.0" })
    expect(entry.level).toBe("info")
    expect(entry.code).toBe("info")
  })

  it("disableStructuredLogging no-ops", () => {
    disableStructuredLogging()
    expect(() => logError(new Error("ignored"))).not.toThrow()
  })
})
