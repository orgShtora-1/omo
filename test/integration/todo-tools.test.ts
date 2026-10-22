import { expect, test } from "bun:test"
import { mountTodoSync } from "../../src/todo/sync"
import { todoFixture } from "../helpers/todo"

test("todo tools use native ownership, separate read/edit permissions and structured outputs", async () => {
  const fixture = todoFixture()
  const todos = await mountTodoSync(fixture.ctx)
  try {
    expect(fixture.tools.get("omo_todo_read")?.options.permission).toBe("read")
    expect(fixture.tools.get("omo_todo_write")?.options.permission).toBe("edit")
    const written = await fixture.call("todo_write", {
      todos: [{ content: "persist", status: "pending", priority: "high" }],
    })
    expect(written.output).toBeDefined()
    expect(JSON.parse(written.content ?? "null")).toEqual(written.output)
    const read = await fixture.call("todo_read", {})
    expect(read.output).toEqual(written.output)
    expect(JSON.parse(read.content ?? "null")).toEqual(read.output)
  } finally {
    await todos()
  }
})

test("native project/location mismatch or cancelled calls cannot write state", async () => {
  const fixture = todoFixture()
  const todos = await mountTodoSync(fixture.ctx)
  try {
    fixture.identity.projectID = "foreign"
    await expect(fixture.call("todo_write", { todos: [] })).rejects.toThrow("foreign-session")
    fixture.identity.projectID = "p"
    fixture.identity.directory = "C:/other"
    await expect(fixture.call("todo_read", {})).rejects.toThrow("foreign-session")
    fixture.identity.directory = "C:/todo-project"
    const controller = new AbortController()
    controller.abort()
    await expect(
      fixture.call("todo_write", { todos: [] }, "s", controller.signal),
    ).rejects.toThrow()
    expect(fixture.values.size).toBe(0)
  } finally {
    await todos()
  }
})

test("reloading a mount preserves the list and disposal is idempotent", async () => {
  const fixture = todoFixture()
  const first = await mountTodoSync(fixture.ctx)
  await fixture.call("todo_write", {
    todos: [{ content: "durable", status: "completed", priority: "low" }],
  })
  await Promise.all([first(), first()])
  expect(fixture.disposed()).toBe(1)
  const next = await mountTodoSync(fixture.ctx)
  try {
    expect((await next.read("s")).todos).toEqual([
      { content: "durable", status: "completed", priority: "low" },
    ])
    const other = todoFixture("C:/different-worktree", fixture.values)
    const isolated = await mountTodoSync(other.ctx)
    try {
      expect((await isolated.read("s")).recorded).toBe(false)
    } finally {
      await isolated()
    }
  } finally {
    await next()
  }
})

test("a second transform fails on collision rather than overwriting another provider", async () => {
  const fixture = todoFixture()
  const first = await mountTodoSync(fixture.ctx)
  try {
    await expect(mountTodoSync(fixture.ctx)).rejects.toThrow("todo tool collision")
  } finally {
    await first()
  }
})

test("disposal waits for admitted plan reads and rejects later reads", async () => {
  const fixture = todoFixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const todos = await mountTodoSync(fixture.ctx, async () => {
    entered.resolve()
    await release.promise
    return []
  })
  const reading = todos.read("s")
  await entered.promise
  const closing = todos()
  try {
    const outcome = await Promise.race([
      closing.then(() => "disposed"),
      Bun.sleep(20).then(() => "pending"),
    ])
    expect(outcome).toBe("pending")
  } finally {
    release.resolve()
    await Promise.all([reading, closing])
  }
  await expect(todos.read("s")).rejects.toThrow("todo-disposed")
})
