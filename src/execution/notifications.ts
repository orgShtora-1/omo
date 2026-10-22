import type { openRunJournal, RunRecord } from "./journal"

type Journal = ReturnType<typeof openRunJournal>

/** One in-app result notice; the OS notification channel mirrors this shape. */
export type Notice = {
  sessionID: string
  id: string
  text: string
  description: string
  delivery: "queue"
  resume: boolean
  metadata: { "omo.attemptIDs": string[] }
}

/** One durable inbox item per completion burst, not one wakeup per child.
 * Batch identity survives a reload or an ambiguous synthetic admission. */
export function createResultNotifier(
  journal: Journal,
  send: (notice: Notice) => Promise<unknown>,
  pause = () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
) {
  const flights = new Map<string, Promise<void>>()
  const terminal = (record: RunRecord) =>
    ["completed", "failed", "cancelled"].includes(record.phase)
  return async (record: RunRecord) => {
    const current = journal.get(record.attemptID)
    if (!current.request.background || current.notification === "sent" || !terminal(current)) return
    journal.notification(current.attemptID, "pending")
    const parent = current.request.parentSessionID
    const active = flights.get(parent)
    if (active) return active
    const flight = (async () => {
      await pause()
      for (;;) {
        const batch = journal.claimNotificationBatch(parent)
        const first = batch[0]
        if (!first) return
        const batchID = first.notificationBatch
        if (!batchID) throw new Error("missing-notification-batch")
        await send({
          sessionID: parent,
          id: batchID,
          text: `${batch
            .map(
              (item) =>
                `OmO task ${item.request.taskID}: ${item.phase}. Session: ${item.sessionID ?? "unresolved"}. Attempt: ${item.attemptID}.${item.error ? ` Error: ${item.error}` : ""}`,
            )
            .join("\n")}\nExecution completion requires evidence before plan completion.`,
          description:
            batch.length === 1
              ? `OmO: ${first.request.taskID} — ${first.phase}`
              : `OmO: ${batch.length} child results`,
          delivery: "queue",
          resume: true,
          metadata: { "omo.attemptIDs": batch.map((item) => item.attemptID) },
        })
        journal.acknowledgeNotificationBatch(batchID)
      }
    })()
    flights.set(parent, flight)
    try {
      await flight
    } finally {
      flights.delete(parent)
    }
  }
}
