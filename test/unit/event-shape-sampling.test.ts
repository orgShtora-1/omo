import { expect, test } from "bun:test"
import { EventDiagnostics } from "../../src/events/diagnostics"

test("recordShape counts event type names and exposes them in the snapshot", () => {
  const diagnostics = new EventDiagnostics()
  diagnostics.recordShape("session.status")
  diagnostics.recordShape("session.status")
  diagnostics.recordShape("tool.execute.end")
  expect(diagnostics.snapshot().shapes).toEqual({
    "session.status": 2,
    "tool.execute.end": 1,
  })
})

test("recordShape ignores non-string type names", () => {
  const diagnostics = new EventDiagnostics()
  diagnostics.recordShape(undefined)
  diagnostics.recordShape(null)
  diagnostics.recordShape(42)
  expect(diagnostics.snapshot().shapes).toEqual({})
})

test("recordShape caps distinct type names so the snapshot cannot grow without bound", () => {
  const diagnostics = new EventDiagnostics()
  for (let index = 0; index < 150; index++) diagnostics.recordShape(`type-${index}`)
  const shapes = diagnostics.snapshot().shapes
  expect(Object.keys(shapes)).toHaveLength(100)
  expect(shapes["type-0"]).toBe(1)
})

test("recordStatusValue counts session.status values under a composite key", () => {
  const diagnostics = new EventDiagnostics()
  diagnostics.recordStatusValue({ type: "session.status", data: { status: { type: "busy" } } })
  diagnostics.recordStatusValue({ type: "session.status", data: { status: { type: "busy" } } })
  diagnostics.recordStatusValue({ type: "session.status", data: { status: { type: "idle" } } })
  expect(diagnostics.snapshot().shapes).toEqual({
    "session.status:busy": 2,
    "session.status:idle": 1,
  })
})

test("recordStatusValue ignores events that are not session.status", () => {
  const diagnostics = new EventDiagnostics()
  diagnostics.recordStatusValue({ type: "session.idle", data: {} })
  diagnostics.recordStatusValue({ type: "tool.execute.end" })
  expect(diagnostics.snapshot().shapes).toEqual({})
})

test("recordStatusValue is null-safe and buckets a missing status value", () => {
  const diagnostics = new EventDiagnostics()
  diagnostics.recordStatusValue(null)
  diagnostics.recordStatusValue("session.status")
  diagnostics.recordStatusValue(42)
  diagnostics.recordStatusValue({ type: "session.status", data: null })
  diagnostics.recordStatusValue({ type: "session.status", data: { status: { type: 7 } } })
  expect(diagnostics.snapshot().shapes).toEqual({ "session.status:<missing>": 2 })
})

test("lastActivity is undefined before any activity", () => {
  const diagnostics = new EventDiagnostics()
  expect(diagnostics.lastActivity()).toBeUndefined()
})

test("noteActivity records the observed timestamp", () => {
  const diagnostics = new EventDiagnostics()
  diagnostics.noteActivity(1234567890)
  expect(diagnostics.lastActivity()).toBe(1234567890)
})

test("noteActivity stays out of the snapshot", () => {
  const diagnostics = new EventDiagnostics()
  diagnostics.noteActivity(1234567890)
  const snapshot = diagnostics.snapshot()
  expect("lastActivity" in snapshot).toBe(false)
  expect(snapshot.seen).toBe(0)
})

test("recordQuietTick counts prompter evaluations", () => {
  const diagnostics = new EventDiagnostics()
  expect(diagnostics.snapshot().quietTicks).toBe(0)
  diagnostics.recordQuietTick()
  diagnostics.recordQuietTick()
  expect(diagnostics.snapshot().quietTicks).toBe(2)
})

test("noteActivityFrom notes activity only for real session output", () => {
  const diagnostics = new EventDiagnostics()
  diagnostics.noteActivityFrom({ type: "config.updated", data: {} })
  diagnostics.noteActivityFrom({ type: "session.status", data: { sessionID: "ses_1" } })
  diagnostics.noteActivityFrom({ type: "session.usage.updated", data: { sessionID: "ses_1" } })
  expect(diagnostics.lastActivity()).toBeUndefined()
  diagnostics.noteActivityFrom({ type: "session.reasoning.delta", data: { sessionID: "ses_1" } })
  expect(typeof diagnostics.lastActivity()).toBe("number")
})

test("noteActivityFrom ignores malformed events without throwing", () => {
  const diagnostics = new EventDiagnostics()
  diagnostics.noteActivityFrom(undefined)
  diagnostics.noteActivityFrom(null)
  diagnostics.noteActivityFrom({})
  diagnostics.noteActivityFrom({ data: null })
  diagnostics.noteActivityFrom({ data: { sessionID: "   " } })
  expect(diagnostics.lastActivity()).toBeUndefined()
})

test("lastActivityFor tracks each session independently", () => {
  const diagnostics = new EventDiagnostics()
  diagnostics.noteActivityFrom({ type: "session.reasoning.delta", data: { sessionID: "ses_a" } })
  expect(typeof diagnostics.lastActivityFor("ses_a")).toBe("number")
  expect(diagnostics.lastActivityFor("ses_b")).toBeUndefined()
  diagnostics.noteActivityFrom({ type: "session.status", data: { sessionID: "ses_b" } })
  expect(diagnostics.lastActivityFor("ses_b")).toBeUndefined()
})
