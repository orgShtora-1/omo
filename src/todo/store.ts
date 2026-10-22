import type { Plan, TaskState } from "../contracts"

export type TodoItem = {
  id?: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
}
type TodoState = { schemaVersion: 1; todos: TodoItem[] }
export type TodoSnapshot = TodoState & { recorded: boolean }
type TodoScope = { projectID: string; directory: string }
interface TodoStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: TodoState): Promise<unknown>
}

const MANAGED_PREFIX = "omo.plan:"

function boundedString(input: unknown, maximum: number): input is string {
  return typeof input === "string" && input.trim().length > 0 && input.length <= maximum
}
function todoStatus(input: unknown): input is TodoItem["status"] {
  return (
    input === "pending" || input === "in_progress" || input === "completed" || input === "cancelled"
  )
}
function todoPriority(input: unknown): input is TodoItem["priority"] {
  return input === "high" || input === "medium" || input === "low"
}
function decodeTodo(raw: unknown): TodoItem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid-todos")
  const { id, content, status, priority } = raw as Record<string, unknown>
  const validID = id === undefined || (boundedString(id, 256) && !id.startsWith(MANAGED_PREFIX))
  if (!boundedString(content, 2000) || !todoStatus(status) || !todoPriority(priority) || !validID)
    throw new Error("invalid-todos")
  return { ...(typeof id === "string" ? { id } : {}), content, status, priority }
}
function decodeTodos(input: unknown): TodoItem[] {
  if (!Array.isArray(input) || input.length > 100) throw new Error("invalid-todos")
  const ids = new Set<string>()
  return input.map((raw) => {
    const todo = decodeTodo(raw)
    if (todo.id !== undefined) {
      if (ids.has(todo.id)) throw new Error("invalid-todos: duplicate id")
      ids.add(todo.id)
    }
    return todo
  })
}

/** Manual lists live in the host's plugin-isolated KV. Plan entries are derived from their own durable repository. */
export class TodoStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: TodoStorage,
    private readonly scope: TodoScope,
  ) {}

  private key(sessionID: string): string {
    if (!sessionID.trim()) throw new Error("native-session-required")
    return `omo.todos/${JSON.stringify([this.scope.projectID, this.scope.directory, sessionID])}`
  }

  private async load(sessionID: string): Promise<TodoSnapshot> {
    const raw = await this.storage.get(this.key(sessionID))
    if (raw === undefined) return { schemaVersion: 1, recorded: false, todos: [] }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("corrupt-todo-state")
    const state = raw as Record<string, unknown>
    if (state.schemaVersion !== 1) throw new Error("unsupported-todo-state-version")
    try {
      return { schemaVersion: 1, recorded: true, todos: decodeTodos(state.todos) }
    } catch (error) {
      throw new Error("corrupt-todo-state", { cause: error })
    }
  }

  async read(sessionID: string): Promise<TodoSnapshot> {
    await this.queue
    return this.load(sessionID)
  }

  write(sessionID: string, value: unknown, signal?: AbortSignal): Promise<TodoSnapshot> {
    const work = this.queue.then(async () => {
      signal?.throwIfAborted()
      const todos = decodeTodos(value)
      // Do not erase a future or corrupt snapshot, even when replacing the whole list.
      await this.load(sessionID)
      signal?.throwIfAborted()
      await this.storage.set(this.key(sessionID), { schemaVersion: 1, todos })
      return { schemaVersion: 1 as const, recorded: true, todos }
    })
    // The caller observes failure; later writes may still proceed. One writer per mounted location, not CAS.
    this.queue = work.catch(() => undefined)
    return work
  }

  async settled(): Promise<void> {
    await this.queue
  }
}

/** A successful child execution remains in progress until the plan's existing evidence gate completes it. */
export function planTodos(plans: readonly Plan[]): TodoItem[] {
  const status: Record<TaskState, TodoItem["status"]> = {
    pending: "pending",
    running: "in_progress",
    verifying: "in_progress",
    completed: "completed",
    blocked: "pending",
    failed: "pending",
    cancelled: "cancelled",
  }
  return plans.flatMap((plan) =>
    plan.steps.map((step) => ({
      id: `${MANAGED_PREFIX}${JSON.stringify([plan.id, step.id])}`,
      content: step.objective,
      status: status[step.state],
      priority: "medium" as const,
    })),
  )
}
