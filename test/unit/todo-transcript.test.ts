import { expect, test } from "bun:test"
import type { TodoSnapshot } from "../../src/todo/store"
import { latestToolSnapshot, type Message } from "../helpers/todo-transcript"

function message(completed: number, status: "pending" | "cancelled"): Message {
  const snapshot: TodoSnapshot = {
    schemaVersion: 1,
    recorded: true,
    todos: [{ content: "plan-task", status, priority: "medium" }],
  }
  return {
    type: "assistant",
    content: [
      {
        type: "tool",
        time: { created: completed, completed },
        state: {
          status: "completed",
          content: [{ type: "text", text: JSON.stringify({ read: snapshot }) }],
        },
      },
    ],
  }
}

test.each(["ascending", "descending"])(
  "latest todo output does not depend on %s message order",
  (order) => {
    const transcript = [message(10, "pending"), message(20, "cancelled")]
    if (order === "descending") transcript.reverse()
    expect(latestToolSnapshot(transcript).todos).toEqual([
      { content: "plan-task", status: "cancelled", priority: "medium" },
    ])
  },
)

test("user text and failed tool calls cannot masquerade as successful todo output", () => {
  const valid = message(20, "cancelled")
  const invented = { schemaVersion: 1, recorded: true, todos: [] }
  const fake: Message = {
    type: "assistant",
    content: [
      {
        type: "tool",
        time: { created: 30, completed: 30 },
        state: { status: "error", content: [{ type: "text", text: JSON.stringify(invented) }] },
      },
    ],
  }
  expect(
    latestToolSnapshot([valid, { type: "user", text: JSON.stringify(invented) }, fake]),
  ).toEqual(latestToolSnapshot([valid]))
  expect(() => latestToolSnapshot([fake])).toThrow("No completed tool returned a todo snapshot")
})
