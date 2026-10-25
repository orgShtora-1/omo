import type { Plugin } from "@opencode/plugin"
import type { TodoSnapshot } from "../todo/store"
import type { TodoReader } from "../todo/sync"

// Compaction Todo Preserver — P2-T2. When context compaction fires, the host
// summarizes the conversation and drops most of the message history. Without a
// helper, pending todos (manual list + plan steps) are lost across the reset.
//
// This module hooks into `session.hook("compaction")` and, before the model sees
// the compacted summary, appends a markdown snapshot of the session's current
// todo list so the agent can continue work without forgetting what was queued.
// The append is best-effort: if reading todos fails or the result is already
// owned by another hook, the compaction proceeds unchanged.

/** Formats a `TodoSnapshot` as a markdown section the model can consume. */
export function formatTodos(snapshot: TodoSnapshot): string {
  if (!snapshot.recorded) return ""
  if (snapshot.todos.length === 0) return "## Pending Todos\n\nNo pending todos."
  const lines = snapshot.todos
    .map(
      (todo) =>
        `- [${todo.status}] (${todo.priority}) ${todo.content.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}`,
    )
    .join("\n")
  return `## Pending Todos\n\n${lines}`
}

/**
 * Register the compaction todo preserver. Fires once per compaction cycle;
 * appends the current todo list to `input.result.summary` so the agent can
 * continue with full awareness of pending work after context is dropped.
 *
 * `todoReader` is typically the `TodoMount` returned by `mountTodoSync`.
 * Default off when `todoReader` is absent: compaction behaves exactly as
 * before.
 */
export async function mountTodoPreserver(
  ctx: Plugin.Context,
  todoReader?: TodoReader,
): Promise<() => Promise<void>> {
  if (!todoReader) return async () => {}
  let disposed = false
  const registration = await ctx.session.hook("compaction", async (input) => {
    // Skip if another hook already owns the result.
    if (input.result !== undefined) return
    try {
      const snapshot = await todoReader.read(input.sessionID)
      const section = formatTodos(snapshot)
      if (!section) return
      // Mutate the summary in-place; the host treats this as the compaction
      // result and will use it for the next model request.
      input.result = { summary: section }
    } catch {
      // Best-effort: foreign session reads and transient storage failures must
      // not break compaction. The host will proceed without the todo section.
    }
  })
  return async () => {
    if (disposed) return
    disposed = true
    await registration.dispose()
  }
}
