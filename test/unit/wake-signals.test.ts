import { describe, expect, test } from "bun:test"
import { EventDiagnostics, eventDiagnostics } from "../../src/events/diagnostics"
import { idleSignalFrom } from "../../src/events/idle"

describe("idleSignalFrom", () => {
  test("accepts a session.idle event with a valid sessionID", () => {
    expect(idleSignalFrom({ type: "session.idle", data: { sessionID: "ses_1" } })).toEqual({
      sessionID: "ses_1",
    })
  })

  test("accepts a session.status event whose status.type is idle", () => {
    expect(
      idleSignalFrom({
        type: "session.status",
        data: { sessionID: "ses_1", status: { type: "idle" } },
      }),
    ).toEqual({ sessionID: "ses_1" })
  })

  test("rejects a session.status event whose status.type is retry", () => {
    expect(
      idleSignalFrom({
        type: "session.status",
        data: {
          sessionID: "ses_1",
          status: { type: "retry", attempt: 2, message: "boom", next: 1 },
        },
      }),
    ).toBeUndefined()
  })

  test("rejects any other event type", () => {
    expect(
      idleSignalFrom({ type: "session.created", data: { sessionID: "ses_1" } }),
    ).toBeUndefined()
    expect(
      idleSignalFrom({ type: "session.usage.updated", data: { sessionID: "ses_1" } }),
    ).toBeUndefined()
  })

  test("rejects an empty or whitespace-only sessionID", () => {
    expect(idleSignalFrom({ type: "session.idle", data: { sessionID: "" } })).toBeUndefined()
    expect(idleSignalFrom({ type: "session.idle", data: { sessionID: "   " } })).toBeUndefined()
    expect(
      idleSignalFrom({
        type: "session.status",
        data: { sessionID: " \t", status: { type: "idle" } },
      }),
    ).toBeUndefined()
  })

  test("rejects a non-string sessionID", () => {
    expect(idleSignalFrom({ type: "session.idle", data: { sessionID: 42 } })).toBeUndefined()
    expect(idleSignalFrom({ type: "session.idle", data: { sessionID: null } })).toBeUndefined()
    expect(
      idleSignalFrom({ type: "session.status", data: { sessionID: 7, status: { type: "idle" } } }),
    ).toBeUndefined()
  })

  test("rejects missing data, missing status and non-object events", () => {
    expect(idleSignalFrom({ type: "session.idle" })).toBeUndefined()
    expect(idleSignalFrom({ type: "session.idle", data: null })).toBeUndefined()
    expect(idleSignalFrom({ type: "session.status", data: { sessionID: "ses_1" } })).toBeUndefined()
    expect(
      idleSignalFrom({ type: "session.status", data: { sessionID: "ses_1", status: null } }),
    ).toBeUndefined()
    expect(idleSignalFrom(null)).toBeUndefined()
    expect(idleSignalFrom("session.idle")).toBeUndefined()
  })
})

describe("EventDiagnostics", () => {
  test("snapshot starts at zero with no error and a fresh instance per export", () => {
    const diagnostics = new EventDiagnostics()
    expect(diagnostics.snapshot()).toEqual({
      seen: 0,
      idleSignals: 0,
      wakeAttempts: 0,
      prompts: 0,
      quietTicks: 0,
      errorCount: 0,
      lastErrors: [],
      lastError: null,
      shapes: {},
    })
    expect(eventDiagnostics).toBeInstanceOf(EventDiagnostics)
    expect(eventDiagnostics).not.toBe(diagnostics)
  })

  test("each counter increments independently", () => {
    const diagnostics = new EventDiagnostics()
    diagnostics.recordSeen()
    diagnostics.recordSeen()
    diagnostics.recordIdle()
    diagnostics.recordWakeAttempt()
    diagnostics.recordWakeAttempt()
    diagnostics.recordWakeAttempt()
    diagnostics.recordPrompt()
    expect(diagnostics.snapshot()).toEqual({
      seen: 2,
      idleSignals: 1,
      wakeAttempts: 3,
      prompts: 1,
      quietTicks: 0,
      errorCount: 0,
      lastErrors: [],
      lastError: null,
      shapes: {},
    })
  })

  test("the error ring keeps the last five messages while errorCount keeps the total", () => {
    const diagnostics = new EventDiagnostics()
    for (let index = 1; index <= 7; index++) diagnostics.recordError(new Error(`boom ${index}`))
    const snapshot = diagnostics.snapshot()
    expect(snapshot.errorCount).toBe(7)
    expect(snapshot.lastErrors).toEqual(["boom 3", "boom 4", "boom 5", "boom 6", "boom 7"])
    expect(snapshot.lastError).toBe("boom 7")
  })

  test("error messages are stringified and truncated to 200 characters", () => {
    const diagnostics = new EventDiagnostics()
    const long = "x".repeat(250)
    diagnostics.recordError(new Error(long))
    diagnostics.recordError("plain string failure")
    const snapshot = diagnostics.snapshot()
    expect(snapshot.lastErrors[0]).toBe(long.slice(0, 200))
    expect(snapshot.lastErrors[0]).toHaveLength(200)
    expect(snapshot.lastError).toBe("plain string failure")
    expect(snapshot.errorCount).toBe(2)
  })
})
