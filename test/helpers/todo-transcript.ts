import type { TodoSnapshot } from "../../src/todo/store"

export type Message = { type?: string; text?: string; content?: unknown[] }

function snapshotsIn(input: unknown): TodoSnapshot[] {
  if (typeof input === "string") {
    try {
      return snapshotsIn(JSON.parse(input))
    } catch (error) {
      if (error instanceof SyntaxError) return []
      throw error
    }
  }
  if (Array.isArray(input)) return input.flatMap(snapshotsIn)
  if (input === null || typeof input !== "object") return []
  const record = input as Record<string, unknown>
  if (
    record.schemaVersion === 1 &&
    typeof record.recorded === "boolean" &&
    Array.isArray(record.todos)
  )
    return [record as unknown as TodoSnapshot]
  return Object.values(record).flatMap(snapshotsIn)
}

export function latestToolSnapshot(transcript: Message[]): TodoSnapshot {
  const snapshots = transcript.flatMap((message) => {
    if (message.type !== "assistant") return []
    return (message.content ?? []).flatMap((entry) => {
      const tool = entry as {
        type?: string
        time?: { completed?: unknown }
        state?: { status?: string; content?: unknown }
      }
      if (tool.type !== "tool" || tool.state?.status !== "completed") return []
      const outputs = snapshotsIn(tool.state.content)
      if (outputs.length === 0) return []
      const completed = tool.time?.completed
      if (typeof completed !== "number" || !Number.isFinite(completed))
        throw new Error("Todo tool output has no native completion timestamp")
      return outputs.map((snapshot) => ({ completed, snapshot }))
    })
  })
  const latest = snapshots.sort((left, right) => right.completed - left.completed)[0]
  if (!latest) throw new Error("No completed tool returned a todo snapshot")
  return latest.snapshot
}
