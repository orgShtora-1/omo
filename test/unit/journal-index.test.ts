import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DelegationRequest, ResolvedDelegation } from "../../src/contracts"
import { openRunJournal } from "../../src/execution/journal"
import { rmSyncRetry } from "./test-utils"

const scope = { projectID: "test-proj", locationID: "/test/loc", parentSessionID: "parent-sess" }

function makeRequest(taskID: string): DelegationRequest {
  return {
    projectID: scope.projectID,
    parentSessionID: scope.parentSessionID,
    taskID,
    route: { kind: "agent", id: "agent-1" },
    prompt: "test prompt",
    skills: [],
    background: false,
  }
}

function makeResolved(): ResolvedDelegation {
  return { agentID: "agent-1", skills: [], prompt: "test", background: false }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omo-journal-"))
  const file = join(dir, "journal.sqlite")
  const journal = openRunJournal(file)
  return {
    journal,
    dir,
    file,
    cleanup: () => {
      journal.close()
      rmSyncRetry(dir)
    },
  }
}

describe("journal indexes - intent with existing active attempt", () => {
  test("rejects duplicate intent using indexed query", () => {
    const { journal, cleanup } = fixture()
    try {
      const req = makeRequest("task-1")
      const res = makeResolved()
      journal.intent("attempt-1", req, res)
      // Second intent with same parent/task should throw
      expect(() => journal.intent("attempt-2", req, res)).toThrow(/unreconciled-attempt/)
    } finally {
      cleanup()
    }
  })

  test("allows intent for different task", () => {
    const { journal, cleanup } = fixture()
    try {
      const req1 = makeRequest("task-1")
      const req2 = makeRequest("task-2")
      const res = makeResolved()
      journal.intent("attempt-1", req1, res)
      // Different task should be allowed
      expect(() => journal.intent("attempt-2", req2, res)).not.toThrow()
    } finally {
      cleanup()
    }
  })

  test("allows retry after terminal state", () => {
    const { journal, cleanup } = fixture()
    try {
      const req = makeRequest("task-1")
      const res = makeResolved()
      journal.intent("attempt-1", req, res)
      journal.terminal("attempt-1", "completed")
      // After completion, retrySafe should allow
      expect(journal.retrySafe(scope.parentSessionID, "task-1")).toBe(true)
    } finally {
      cleanup()
    }
  })
})

describe("journal indexes - retrySafe", () => {
  test("returns false when active attempt exists", () => {
    const { journal, cleanup } = fixture()
    try {
      const req = makeRequest("task-1")
      const res = makeResolved()
      journal.intent("attempt-1", req, res)
      expect(journal.retrySafe(scope.parentSessionID, "task-1")).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("returns true when no active attempt exists", () => {
    const { journal, cleanup } = fixture()
    try {
      expect(journal.retrySafe(scope.parentSessionID, "task-1")).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("returns true after terminal completion", () => {
    const { journal, cleanup } = fixture()
    try {
      const req = makeRequest("task-1")
      const res = makeResolved()
      journal.intent("attempt-1", req, res)
      journal.terminal("attempt-1", "completed")
      expect(journal.retrySafe(scope.parentSessionID, "task-1")).toBe(true)
    } finally {
      cleanup()
    }
  })
})

describe("journal indexes - unresolved", () => {
  test("returns only non-terminal runs", () => {
    const { journal, cleanup } = fixture()
    try {
      const req1 = makeRequest("task-1")
      const req2 = makeRequest("task-2")
      const res = makeResolved()
      journal.intent("attempt-1", req1, res)
      journal.intent("attempt-2", req2, res)
      journal.terminal("attempt-2", "completed")

      const unresolved = journal.unresolved()
      expect(unresolved).toHaveLength(1)
      expect(unresolved[0]?.attemptID).toBe("attempt-1")
    } finally {
      cleanup()
    }
  })
})

describe("journal indexes - performance under load", () => {
  test("intent remains fast with many records", { timeout: 30000 }, () => {
    const { journal, cleanup } = fixture()
    try {
      // Create 500 completed records (reduced for Windows performance)
      for (let i = 0; i < 500; i++) {
        const req = makeRequest(`task-${i}`)
        const res = makeResolved()
        journal.intent(`attempt-${i}`, req, res)
        journal.terminal(`attempt-${i}`, "completed")
      }
      // Now a new intent should still be fast
      const start = performance.now()
      const newReq = makeRequest("new-task")
      journal.intent("new-attempt", newReq, makeResolved())
      const elapsed = performance.now() - start
      // Should be well under 100ms even with 500 records (Windows can be slower)
      expect(elapsed).toBeLessThan(100)
    } finally {
      cleanup()
    }
  })
})
