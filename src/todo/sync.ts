import type { Plugin } from "@opencode/plugin"
import type { Plan } from "../contracts"
import { planTodos, type TodoSnapshot, TodoStore } from "./store"

export type TodoReader = { read(sessionID: string, signal?: AbortSignal): Promise<TodoSnapshot> }
export type TodoMount = (() => Promise<void>) & TodoReader
type PlanSource = (sessionID: string) => Promise<readonly Plan[]>

/** V2 has no native todo API. This surface joins a manual list with current, evidence-gated plan steps. */
export async function mountTodoSync(
  ctx: Plugin.Context,
  plans: PlanSource = async () => [],
): Promise<TodoMount> {
  const store = new TodoStore(ctx.storage, {
    projectID: ctx.location.project.id,
    directory: ctx.location.directory,
  })
  let stopping = false
  const active = new Set<Promise<unknown>>()
  function admit<T>(work: () => Promise<T>): Promise<T> {
    if (stopping) return Promise.reject(new Error("todo-disposed"))
    const pending = work()
    active.add(pending)
    pending.then(
      () => active.delete(pending),
      () => active.delete(pending),
    )
    return pending
  }
  async function owner(sessionID: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (typeof sessionID !== "string" || !sessionID.trim())
      throw new Error("native-session-required")
    const session = await ctx.session.get({ sessionID }, { signal })
    signal?.throwIfAborted()
    if (
      session.id !== sessionID ||
      session.projectID !== ctx.location.project.id ||
      session.location.directory !== ctx.location.directory
    )
      throw new Error("foreign-session")
  }
  async function snapshot(sessionID: string, signal?: AbortSignal): Promise<TodoSnapshot> {
    await owner(sessionID, signal)
    const [manual, current] = await Promise.all([store.read(sessionID), plans(sessionID)])
    signal?.throwIfAborted()
    if (
      current.some(
        (plan) => plan.projectID !== ctx.location.project.id || plan.parentSessionID !== sessionID,
      )
    )
      throw new Error("foreign-plan")
    return {
      schemaVersion: 1,
      recorded: manual.recorded || current.length > 0,
      todos: [...manual.todos, ...planTodos(current)],
    }
  }
  const read = (sessionID: string, signal?: AbortSignal) => admit(() => snapshot(sessionID, signal))
  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omo", description: "OmO custom tools" })
    if (editor.get("omo_todo_read") || editor.get("omo_todo_write"))
      throw new Error("todo tool collision")
    editor.add({
      name: "todo_read",
      description:
        "Read this session's durable OmO todos and the latest plan-step statuses. Plan completion follows evidence verification, not model success.",
      options: { namespace: "omo", permission: "read" },
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {},
      async execute(_input, context) {
        const output = await read(context.sessionID, context.signal)
        return { output, content: JSON.stringify(output) }
      },
    })
    editor.add({
      name: "todo_write",
      description:
        "Replace only this session's manual OmO todo list (up to 100 items); [] clears it. Plan-derived entries are read-only and remain visible in todo_read and /handoff. Do not pass managed omo.plan: IDs.",
      options: { namespace: "omo", permission: "edit" },
      input: {
        type: "object",
        additionalProperties: false,
        required: ["todos"],
        properties: {
          todos: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["content", "status", "priority"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 256 },
                content: { type: "string", minLength: 1, maxLength: 2000 },
                status: { enum: ["pending", "in_progress", "completed", "cancelled"] },
                priority: { enum: ["high", "medium", "low"] },
              },
            },
          },
        },
      },
      output: {},
      async execute(input, context) {
        const output = await admit(async () => {
          await owner(context.sessionID, context.signal)
          const { todos } = input as { todos: unknown }
          await store.write(context.sessionID, todos, context.signal)
          return snapshot(context.sessionID, context.signal)
        })
        return { output, content: JSON.stringify(output) }
      },
    })
  })
  let cleanup: Promise<void> | undefined
  const dispose = (() =>
    (cleanup ??= (async () => {
      stopping = true
      await registration.dispose()
      await Promise.allSettled([...active])
      await store.settled()
    })())) as TodoMount
  dispose.read = read
  return dispose
}
