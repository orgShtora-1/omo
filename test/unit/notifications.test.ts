import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openRunJournal } from "../../src/execution/journal"
import { createResultNotifier } from "../../src/execution/notifications"

interface SentNotice {
  id: string
  text: string
  description: string
}

function first<T>(items: readonly T[], what: string): T {
  const head = items[0]
  if (head === undefined) throw new Error(`expected ${what}`)
  return head
}

test("persistent independent notifiers preserve batch membership and accepted legacy IDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "omo-notice-"))
  const path = join(root, "runs.sqlite")
  const first = openRunJournal(path)
  const second = openRunJournal(path)
  try {
    const a = completed(first, "a")
    completed(first, "b")
    const batch = first.claimNotificationBatch("parent")
    completed(second, "c")
    expect(second.claimNotificationBatch("parent").map((item) => item.attemptID)).toEqual(
      batch.map((item) => item.attemptID),
    )
    const accepted = new Map<string, string>()
    const send = async (notice: SentNotice) => {
      const seen = accepted.get(notice.id)
      if (seen !== undefined) expect(notice.text).toBe(seen)
      else accepted.set(notice.id, notice.text)
    }
    await Promise.all([
      createResultNotifier(first, send, async () => {})(a),
      createResultNotifier(second, send, async () => {})(a),
    ])
    expect(accepted.size).toBe(2)
    expect([...accepted.values()].join("\n")).toContain("task c: completed")
    completed(first, "legacy-a")
    completed(first, "legacy-b")
    first.notification("legacy-a", "pending")
    first.notification("legacy-b", "pending")
    second.migrateNotifications()
    const delivered: string[] = []
    await createResultNotifier(
      second,
      async (notice) => {
        delivered.push(notice.id)
      },
      async () => {},
    )(second.get("legacy-a"))
    expect(delivered).toEqual(["msg_omo_result_legacya", "msg_omo_result_legacyb"])
  } finally {
    first.close()
    second.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("legacy pending IDs migrate before any parent batch is drained", () => {
  const journal = openRunJournal(":memory:")
  completed(journal, "a")
  completed(journal, "b")
  journal.notification("a", "pending")
  journal.notification("b", "pending")
  journal.migrateNotifications()
  expect(journal.list().map((item) => item.notificationBatch)).toEqual([
    "msg_omo_result_a",
    "msg_omo_result_b",
  ])
  journal.close()
})

test("batch acknowledgement marks every claimed member together", () => {
  const journal = openRunJournal(":memory:")
  completed(journal, "a")
  completed(journal, "b")
  const batch = journal.claimNotificationBatch("parent")
  const head = first(batch, "claimed notification batch")
  if (!head.notificationBatch) throw new Error("claimed batch is missing its notification ID")
  journal.acknowledgeNotificationBatch(head.notificationBatch)
  expect(journal.list().every((item) => item.notification === "sent")).toBe(true)
  expect(journal.claimNotificationBatch("parent")).toEqual([])
  journal.close()
})

test("batch membership and first terminal outcome stay immutable", () => {
  const journal = openRunJournal(":memory:")
  completed(journal, "a")
  const first = journal.claimNotificationBatch("parent")
  completed(journal, "b")
  const retry = journal.claimNotificationBatch("parent")
  expect(retry.map((item) => item.attemptID)).toEqual(first.map((item) => item.attemptID))
  journal.terminal("a", "failed", "stale failure")
  expect(journal.get("a").phase).toBe("completed")
  journal.close()
})

function completed(journal: ReturnType<typeof openRunJournal>, id: string, parent = "parent") {
  journal.intent(
    id,
    {
      projectID: "p",
      parentSessionID: parent,
      taskID: id,
      route: { kind: "agent", id: "worker" },
      prompt: "work",
      skills: [],
      background: true,
    },
    { agentID: "worker", prompt: "work", skills: [], background: true },
  )
  return journal.terminal(id, "completed")
}

test("a completion burst produces one descriptive notification, including stale duplicate calls", async () => {
  const journal = openRunJournal(":memory:")
  const a = completed(journal, "a")
  const b = completed(journal, "b")
  const notices: SentNotice[] = []
  const notify = createResultNotifier(
    journal,
    async (notice) => {
      notices.push(notice)
    },
    async () => {},
  )
  await Promise.all([notify(a), notify(a), notify(b)])
  await notify(a)
  expect(notices).toHaveLength(1)
  const deliveredNotice = first(notices, "completion burst notification")
  expect(deliveredNotice.description).toBe("OmO: 2 child results")
  expect(deliveredNotice.text).toContain("task a: completed")
  expect(deliveredNotice.text).toContain("task b: completed")
  journal.close()
})

test("ambiguous delivery retries the persisted batch ID even when a new child completes", async () => {
  const journal = openRunJournal(":memory:")
  const a = completed(journal, "a")
  const ids: string[] = []
  const notify = createResultNotifier(
    journal,
    async (notice) => {
      ids.push(notice.id)
      throw new Error("lost acknowledgement")
    },
    async () => {},
  )
  await expect(notify(a)).rejects.toThrow("lost acknowledgement")
  completed(journal, "b")
  const retry = createResultNotifier(
    journal,
    async (notice) => {
      ids.push(notice.id)
    },
    async () => {},
  )
  await retry(a)
  expect(ids[1]).toBe(ids[0])
  expect(ids[2]).not.toBe(ids[0])
  expect(journal.list().every((item) => item.notification === "sent")).toBe(true)
  journal.close()
})
