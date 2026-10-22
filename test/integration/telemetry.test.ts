import { expect, test } from "bun:test"
import { createTelemetry } from "../../src/telemetry/events"

test("diagnostics reject malformed persisted events and sanitize recovered fields", async () => {
  let value: unknown = [null]
  const telemetry = createTelemetry(
    {
      get: async () => value,
      set: async (_key, next) => {
        value = next
      },
    },
    "project/corrupt",
  )
  await expect(telemetry.collectDiagnostics()).rejects.toThrow("corrupt-diagnostics")
  value = [
    {
      eventID: "evt",
      attemptID: "a",
      sessionID: "s",
      state: "completed",
      at: 10,
      prompt: "PRIVATE-PROMPT",
      error: "api_key=PRIVATE-KEY",
    },
  ]
  const recovered = await telemetry.collectDiagnostics()
  expect(recovered.events).toHaveLength(1)
  expect(JSON.stringify(recovered)).not.toContain("PRIVATE-PROMPT")
  expect(JSON.stringify(recovered)).not.toContain("PRIVATE-KEY")
  value = [{ eventID: "evt", attemptID: "a", sessionID: "s", state: "unknown", at: 10 }]
  await expect(telemetry.collectDiagnostics()).rejects.toThrow("corrupt-diagnostics")
})

test("diagnostics deduplicate run events and exclude prompts and credentials", async () => {
  const data = new Map<string, unknown>()
  const telemetry = createTelemetry(
    {
      get: async (key: string) => data.get(key),
      set: async (key: string, value: unknown) => {
        data.set(key, value)
      },
    },
    "project/location",
  )
  const event = {
    eventID: "evt",
    attemptID: "attempt",
    sessionID: "child",
    state: "failed" as const,
  }
  await telemetry.recordRunEvent(event, {
    at: 12,
    model: "provider/model",
    error: "Authorization: Bearer SECRET api_key=PRIVATE",
  })
  await telemetry.recordRunEvent(event, { at: 13 })
  const diagnostics = await telemetry.collectDiagnostics()
  expect(diagnostics.events).toHaveLength(1)
  expect(diagnostics.events[0]?.at).toBe(12)
  expect(diagnostics.events[0]?.model).toBe("provider/model")
  expect(JSON.stringify(diagnostics)).not.toContain("SECRET")
  expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE")
  const recovered = createTelemetry(
    {
      get: async (key: string) => data.get(key),
      set: async (key: string, value: unknown) => {
        data.set(key, value)
      },
    },
    "project/location",
  )
  expect((await recovered.collectDiagnostics()).events).toHaveLength(1)
})

test("concurrent terminal events retain both records and isolate locations", async () => {
  const data = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => {
      data.set(key, value)
    },
  }
  const telemetry = createTelemetry(storage, "project/a", 2)
  await Promise.all(
    ["a", "b", "c"].map((eventID) =>
      telemetry.recordRunEvent(
        {
          eventID,
          attemptID: eventID,
          sessionID: eventID,
          state: "completed",
        },
        { at: 10 },
      ),
    ),
  )
  expect((await telemetry.collectDiagnostics()).events.map((item) => item.eventID)).toEqual([
    "b",
    "c",
  ])
  expect((await createTelemetry(storage, "project/b").collectDiagnostics()).events).toEqual([])
})
