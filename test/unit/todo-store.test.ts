import { expect, test } from "bun:test"
import type { Plan, TaskState } from "../../src/contracts"
import { planTodos, type TodoItem, TodoStore } from "../../src/todo/store"

function storage() {
  const values = new Map<string, unknown>()
  return {
    values,
    async get(key: string) {
      return values.get(key)
    },
    async set(key: string, value: unknown) {
      values.set(key, structuredClone(value))
    },
  }
}
const scope = { projectID: "p", directory: "C:/project" }
const manual: TodoItem[] = [{ content: "manual", status: "pending", priority: "high" }]

test("todos survive a new store and reads return independent copies", async () => {
  const kv = storage()
  await new TodoStore(kv, scope).write("s", manual)
  const reopened = new TodoStore(kv, scope)
  const snapshot = await reopened.read("s")
  expect(snapshot.recorded).toBe(true)
  expect(snapshot.todos).toEqual(manual)
  const first = snapshot.todos[0]
  if (first) first.content = "changed"
  expect((await reopened.read("s")).todos).toEqual(manual)
})

test("project, location and session all isolate persisted lists", async () => {
  const kv = storage()
  await new TodoStore(kv, scope).write("s", manual)
  for (const [location, session] of [
    [{ projectID: "other", directory: scope.directory }, "s"],
    [{ ...scope, directory: "C:/worktree" }, "s"],
    [scope, "other"],
  ] as const) {
    expect((await new TodoStore(kv, location).read(session)).recorded).toBe(false)
  }
})

test("an explicitly cleared list is distinct from an unknown list", async () => {
  const store = new TodoStore(storage(), scope)
  expect(await store.read("s")).toEqual({ schemaVersion: 1, recorded: false, todos: [] })
  await store.write("s", manual)
  await store.write("s", [])
  expect(await store.read("s")).toEqual({ schemaVersion: 1, recorded: true, todos: [] })
})

test("invalid items fail atomically without weakening the existing list", async () => {
  const store = new TodoStore(storage(), scope)
  await store.write("s", manual)
  for (const invalid of [
    [{ content: "bad", status: "unknown", priority: "high" }],
    [{ content: "bad", status: "pending", priority: "urgent" }],
    [{ content: "", status: "pending", priority: "low" }],
    [{ id: "omo.plan:reserved", content: "spoof", status: "completed", priority: "low" }],
    [...manual, { content: 1, status: "pending", priority: "low" }],
  ]) {
    await expect(store.write("s", invalid)).rejects.toThrow("invalid-todos")
    expect((await store.read("s")).todos).toEqual(manual)
  }
})

test("future or corrupt snapshots are not overwritten", async () => {
  const kv = storage()
  const store = new TodoStore(kv, scope)
  await store.write("s", manual)
  const key = [...kv.values.keys()][0]
  if (!key) throw new Error("missing persisted key")
  for (const value of [
    { schemaVersion: 2, todos: manual },
    { schemaVersion: 1, todos: "bad" },
  ]) {
    kv.values.set(key, value)
    await expect(store.read("s")).rejects.toThrow("todo-state")
    await expect(store.write("s", [])).rejects.toThrow("todo-state")
    expect(kv.values.get(key)).toEqual(value)
  }
})

test("queued writes retain admission order and a failed write does not poison the queue", async () => {
  const kv = storage()
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  const slow = {
    get: kv.get,
    async set(key: string, value: unknown) {
      writes++
      if (writes === 1) {
        entered?.()
        await gate
      }
      await kv.set(key, value)
    },
  }
  const store = new TodoStore(slow, scope)
  const first = store.write("s", manual)
  await ready
  const second = store.write("s", [{ content: "second", status: "completed", priority: "low" }])
  release?.()
  await Promise.all([first, second])
  expect((await store.read("s")).todos[0]?.content).toBe("second")
  await expect(store.write("s", null)).rejects.toThrow("invalid-todos")
  await store.write("s", [])
  expect((await store.read("s")).todos).toEqual([])
})

test("plan projection uses the verified state, not a successful execution or stale manual copy", () => {
  const states: TaskState[] = [
    "pending",
    "running",
    "verifying",
    "completed",
    "blocked",
    "failed",
    "cancelled",
  ]
  const plan: Plan = {
    schemaVersion: 1,
    id: "plan",
    projectID: "p",
    parentSessionID: "s",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    appliedEvents: [],
    steps: states.map((state) => ({
      id: state,
      objective: state,
      dependencies: [],
      state,
      attempts: [],
      evidence: [],
    })),
  }
  const todos = planTodos([plan])
  expect(todos.map((todo) => todo.status)).toEqual([
    "pending",
    "in_progress",
    "in_progress",
    "completed",
    "pending",
    "pending",
    "cancelled",
  ])
  expect(new Set(todos.map((todo) => todo.id)).size).toBe(states.length)
  expect(todos.every((todo) => todo.priority === "medium")).toBe(true)
  expect(planTodos([{ ...plan, id: "different" }])[0]?.id).not.toBe(todos[0]?.id)
})

test("cancelling a queued write before admission leaves the prior durable state intact", async () => {
  const kv = storage()
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const store = new TodoStore(
    {
      get: kv.get,
      async set(key, snapshot) {
        entered?.()
        await gate
        await kv.set(key, snapshot)
      },
    },
    scope,
  )
  const first = store.write("s", manual)
  await ready
  const controller = new AbortController()
  const queued = store.write("s", [], controller.signal)
  controller.abort()
  release?.()
  await first
  await expect(queued).rejects.toThrow()
  expect((await store.read("s")).todos).toEqual(manual)
})
