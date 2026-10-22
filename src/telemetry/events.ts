import type { RunEvent } from "../contracts"
import { redactDiagnostic } from "./diagnostics"

type DiagnosticEvent = RunEvent & {
  at: number
  model?: string
  error?: string
}
interface DiagnosticStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: DiagnosticEvent[]): Promise<unknown>
}

function decodeEvent(value: unknown): DiagnosticEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("corrupt-diagnostics")
  const item = value as Record<string, unknown>
  const { eventID, attemptID, sessionID, state, at, model, error } = item
  if (
    typeof eventID !== "string" ||
    !eventID ||
    typeof attemptID !== "string" ||
    !attemptID ||
    typeof sessionID !== "string" ||
    !sessionID ||
    typeof at !== "number" ||
    !Number.isFinite(at) ||
    (state !== "pending" &&
      state !== "running" &&
      state !== "verifying" &&
      state !== "completed" &&
      state !== "blocked" &&
      state !== "failed" &&
      state !== "cancelled") ||
    (model !== undefined && typeof model !== "string") ||
    (error !== undefined && typeof error !== "string")
  ) {
    throw new Error("corrupt-diagnostics")
  }
  return {
    eventID,
    attemptID,
    sessionID,
    state,
    at,
    ...(model ? { model } : {}),
    ...(error ? { error: redactDiagnostic(error).slice(0, 2000) } : {}),
  }
}

/** One serialized writer per mounted plugin; storage is not advertised as a cross-process transaction. */
export function createTelemetry(storage: DiagnosticStorage, scope: string, limit = 200) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid-diagnostics-limit")
  const key = `omo.diagnostics/${scope}`
  let queue = Promise.resolve()
  async function read(): Promise<DiagnosticEvent[]> {
    const value = await storage.get(key)
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) throw new Error("corrupt-diagnostics")
    return value.map(decodeEvent).slice(-limit)
  }
  return {
    recordRunEvent(
      event: RunEvent,
      details: { at: number; model?: string; error?: string },
    ): Promise<void> {
      const work = queue.then(async () => {
        const events = await read()
        if (events.some((item) => item.eventID === event.eventID)) return
        const item = decodeEvent({
          eventID: event.eventID,
          attemptID: event.attemptID,
          sessionID: event.sessionID,
          state: event.state,
          at: details.at,
          ...(details.model ? { model: details.model } : {}),
          ...(details.error ? { error: redactDiagnostic(details.error).slice(0, 2000) } : {}),
        })
        await storage.set(key, [...events, item].slice(-limit))
      })
      queue = work.catch(() => {})
      return work
    },
    async collectDiagnostics() {
      await queue
      return { schemaVersion: 1, scope, events: await read() }
    },
  }
}
