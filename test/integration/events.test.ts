import { expect, test } from "bun:test"
import { createRunEventTracker, subscribeRunEvents } from "../../src/host/events.js"

test("owned native execution events retain attempt and host event identity", () => {
  const events = createRunEventTracker()
  events.track("child", "attempt-1", 10)
  expect(
    events.accept({
      id: "event-11",
      type: "session.execution.started",
      data: { sessionID: "child" },
      durable: { seq: 11 },
    }),
  ).toEqual({
    attemptID: "attempt-1",
    sessionID: "child",
    state: "running",
    eventID: "event-11",
  })
  expect(
    events.accept({
      id: "event-12",
      type: "session.execution.succeeded",
      data: { sessionID: "child" },
      durable: { seq: 12 },
    }),
  ).toEqual({
    attemptID: "attempt-1",
    sessionID: "child",
    state: "completed",
    eventID: "event-12",
  })
  expect(
    events.accept({
      id: "foreign",
      type: "session.execution.succeeded",
      data: { sessionID: "other" },
      durable: { seq: 1 },
    }),
  ).toBeUndefined()
})
test("duplicates and late events cannot regress or complete another attempt", () => {
  const events = createRunEventTracker()
  events.track("child", "attempt-1", 10)
  const success = {
    id: "success",
    type: "session.execution.succeeded",
    data: { sessionID: "child" },
    durable: { seq: 12 },
  }
  expect(events.accept({ ...success, id: "old", durable: { seq: 10 } })).toBeUndefined()
  expect(events.accept(success)?.state).toBe("completed")
  expect(events.accept(success)).toBeUndefined()
  expect(
    events.accept({
      ...success,
      id: "late-start",
      type: "session.execution.started",
      durable: { seq: 11 },
    }),
  ).toBeUndefined()
  expect(
    events.accept({
      ...success,
      id: "late-failure",
      type: "session.execution.failed",
      durable: { seq: 13 },
    }),
  ).toBeUndefined()
  events.track("child", "attempt-2", 13)
  expect(events.accept(success)).toBeUndefined()
  expect(
    events.accept({
      ...success,
      id: "next-start",
      type: "session.execution.started",
      durable: { seq: 14 },
    })?.attemptID,
  ).toBe("attempt-2")
})
test("subscription delivers one terminal event and exposes stream failures", async () => {
  const tracker = createRunEventTracker()
  tracker.track("child", "attempt-1")
  const received: string[] = []
  const host = {
    async *subscribe(_input: { signal: AbortSignal }) {
      const event = {
        id: "completed",
        type: "session.execution.succeeded",
        data: { sessionID: "child" },
        durable: { seq: 1 },
      }
      yield event
      yield event
      throw new Error("stream unavailable")
    },
  }
  const subscription = subscribeRunEvents(host, tracker, async (event) => {
    received.push(event.eventID)
  })
  await expect(subscription.done).rejects.toThrow("stream unavailable")
  expect(received).toEqual(["completed"])
  subscription.dispose()
  subscription.dispose()
})
test("subscription cleanup aborts only its own stream and resolves orderly shutdown", async () => {
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  let signal: AbortSignal | undefined
  const host = {
    async *subscribe(input: { signal: AbortSignal }) {
      signal = input.signal
      resolveReady()
      await new Promise<void>((_resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new DOMException("stopped", "AbortError")),
          { once: true },
        )
      })
      yield { id: "unused", type: "session.idle", data: {} }
    },
  }
  const subscription = subscribeRunEvents(host, createRunEventTracker(), async () => {})
  await ready
  subscription.dispose()
  await expect(subscription.done).resolves.toBeUndefined()
  expect(signal?.aborted).toBe(true)
})
