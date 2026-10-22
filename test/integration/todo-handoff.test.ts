import { expect, test } from "bun:test"
import type { Plan } from "../../src/contracts"
import { mountHandoff } from "../../src/handoff/commands"
import { mountTodoSync } from "../../src/todo/sync"
import { todoFixture } from "../helpers/todo"

test("the handoff carries the actual persisted todo list for the invoking session", async () => {
  const fixture = todoFixture()
  const todos = await mountTodoSync(fixture.ctx)
  const stopHandoff = await mountHandoff(fixture.ctx, todos)
  try {
    await fixture.call("todo_write", {
      todos: [{ content: "alpha-task", status: "in_progress", priority: "high" }],
    })
    await fixture.handoff()
    expect(fixture.prompts[0]?.sessionID).toBe("s")
    expect(fixture.prompts[0]?.text).toContain("## Live todo state")
    expect(fixture.prompts[0]?.text).toContain("- [in_progress] (high) alpha-task")
    await fixture.handoff("other")
    expect(fixture.prompts[1]?.text).not.toContain("alpha-task")
  } finally {
    await stopHandoff()
    await todos()
  }
})

test("the handoff distinguishes no recorded list from a list deliberately cleared", async () => {
  const fixture = todoFixture()
  const todos = await mountTodoSync(fixture.ctx)
  const stopHandoff = await mountHandoff(fixture.ctx, todos)
  try {
    await fixture.handoff()
    expect(fixture.prompts[0]?.text).toContain("No todo list has been recorded for this session.")
    await fixture.call("todo_write", { todos: [] })
    await fixture.handoff()
    expect(fixture.prompts[1]?.text).toContain("The OmO todo list is empty.")
    expect(fixture.prompts[1]?.text).not.toContain("No todo list has been recorded")
  } finally {
    await stopHandoff()
    await todos()
  }
})

test("plan changes are synchronized at consumption and preserve independent manual todos", async () => {
  const fixture = todoFixture()
  let plan: Plan = {
    schemaVersion: 1,
    id: "plan",
    projectID: "p",
    parentSessionID: "s",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    appliedEvents: [],
    steps: [
      {
        id: "verify",
        objective: "plan-task",
        state: "verifying",
        attempts: [],
        evidence: [],
        dependencies: [],
      },
    ],
  }
  const todos = await mountTodoSync(fixture.ctx, async () => [plan])
  const stopHandoff = await mountHandoff(fixture.ctx, todos)
  try {
    await fixture.call("todo_write", {
      todos: [{ content: "manual-task", status: "pending", priority: "low" }],
    })
    expect((await todos.read("s")).todos.map((todo) => todo.status)).toEqual([
      "pending",
      "in_progress",
    ])
    plan = { ...plan, steps: plan.steps.map((step) => ({ ...step, state: "completed" })) }
    await fixture.handoff()
    expect(fixture.prompts[0]?.text).toContain("- [completed] (medium) plan-task")
    expect(fixture.prompts[0]?.text).toContain("- [pending] (low) manual-task")
    await fixture.call("todo_write", { todos: [] })
    expect((await todos.read("s")).todos.map((todo) => todo.content)).toEqual(["plan-task"])
  } finally {
    await stopHandoff()
    await todos()
  }
})
