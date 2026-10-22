import { expect, test } from "bun:test"
import { planProgress } from "../../src/boulder/progress"

test("plan progress counts tasks and reports the first unfinished task", () => {
  expect(planProgress("# Plan\n- [x] First\n- [ ] Second\n- [X] Third")).toEqual({
    total: 3,
    completed: 2,
    remaining: 1,
    next: { line: 3, label: "Second" },
  })
})

test("plan progress ignores fenced examples and nested subtasks", () => {
  const text = [
    "- [x] Real task",
    "  - [ ] Nested detail",
    "```md",
    "- [ ] Example",
    "````",
    "~~~",
    "- [ ] Another example",
    "~~~",
    "- [ ] Remaining task",
  ].join("\n")
  expect(planProgress(text)).toEqual({
    total: 2,
    completed: 1,
    remaining: 1,
    next: { line: 9, label: "Remaining task" },
  })
})

test("plan progress supports numbered tasks CRLF and empty plans", () => {
  expect(planProgress("1. [ ] Ship\r\n2) [x] Verify")).toEqual({
    total: 2,
    completed: 1,
    remaining: 1,
    next: { line: 1, label: "Ship" },
  })
  expect(planProgress("# Nothing scheduled")).toEqual({
    total: 0,
    completed: 0,
    remaining: 0,
    next: null,
  })
})
