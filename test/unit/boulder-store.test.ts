import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openBoulderStore } from "../../src/boulder/store"
import { rmRetry } from "./test-utils"

test("boulder ownership and progress survive reopening the project store", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-boulder-"))
  let store: ReturnType<typeof openBoulderStore>
  try {
    await writeFile(join(root, "plan.md"), "- [x] First\n- [ ] Ship\n")
    store = openBoulderStore(root)
    const work = store.start("owner", "plan.md")
    expect(work.status).toBe("active")
    expect(openBoulderStore(root).get("owner")).toEqual(work)
    expect(store.get("other-session")).toBeNull()
    expect(store.progress("owner")?.next).toEqual({ line: 2, label: "Ship" })
    await writeFile(join(root, "plan.md"), "- [x] First\n- [x] Ship\n")
    expect(store.progress("owner")?.remaining).toBe(0)
  } finally {
    store?.close()
    await rmRetry(root)
  }
})

test("boulder rejects escaped plans and missing identity without replacing current work", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-boulder-"))
  const outside = await mkdtemp(join(tmpdir(), "omo-boulder-outside-"))
  let store: ReturnType<typeof openBoulderStore>
  try {
    await writeFile(join(root, "plan.md"), "- [ ] Ship")
    await writeFile(join(outside, "plan.md"), "- [ ] Foreign")
    store = openBoulderStore(root)
    const initial = store.start("owner", "plan.md")
    expect(() => store.start("owner", join(outside, "plan.md"))).toThrow("outside-project")
    expect(() => store.start(" ", "plan.md")).toThrow("native-session-required")
    expect(store.get("owner")).toEqual(initial)
  } finally {
    store?.close()
    await rmRetry(root)
    await rmRetry(outside)
  }
})

test("boulder terminal work cannot resume and paused work requires explicit resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-boulder-"))
  let store: ReturnType<typeof openBoulderStore>
  try {
    await writeFile(join(root, "plan.md"), "- [ ] Ship")
    store = openBoulderStore(root)
    store.start("owner", "plan.md")
    expect(store.transition("owner", "paused")?.status).toBe("paused")
    expect(openBoulderStore(root).get("owner")?.status).toBe("paused")
    expect(store.transition("owner", "active")?.status).toBe("active")
    expect(store.transition("owner", "completed")?.status).toBe("completed")
    expect(() => store.transition("owner", "active")).toThrow("terminal-work")
    expect(store.get("owner")?.status).toBe("completed")
  } finally {
    store?.close()
    await rmRetry(root)
  }
})

test("boulder keeps records in the state home and plan documents in the project root", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "omo-boulder-state-"))
  const projectRoot = await mkdtemp(join(tmpdir(), "omo-boulder-project-"))
  let store: ReturnType<typeof openBoulderStore>
  let reopened: ReturnType<typeof openBoulderStore>
  try {
    await writeFile(join(projectRoot, "PLAN.md"), "- [ ] Ship\n")
    store = openBoulderStore(stateHome, { projectRoot })
    const work = store.start("s1", "PLAN.md")
    expect(work.plan).toBe("PLAN.md")
    // Verify persistence across store reopenings (replaces file-read check).
    reopened = openBoulderStore(stateHome, { projectRoot })
    const reloaded = reopened.get("s1")
    expect(reloaded).not.toBeNull()
    expect(reloaded?.plan).toBe("PLAN.md")
    // Plan document lives in the project root, not the state home.
    expect(await readFile(join(projectRoot, "PLAN.md"), "utf8").catch(() => null)).toBe(
      "- [ ] Ship\n",
    )
    expect(await readFile(join(stateHome, "PLAN.md"), "utf8").catch(() => null)).toBeNull()
    // Progress reads the plan document from the project root.
    expect(reopened.progress("s1", work.id)?.remaining).toBe(1)
  } finally {
    store?.close()
    reopened?.close()
    await rmRetry(stateHome)
    await rmRetry(projectRoot)
  }
})

test("boulder accepts absolute plans inside the project root and refuses ones outside it", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "omo-boulder-state-"))
  const projectRoot = await mkdtemp(join(tmpdir(), "omo-boulder-project-"))
  let store: ReturnType<typeof openBoulderStore>
  try {
    await writeFile(join(projectRoot, "PLAN.md"), "- [x] Done\n")
    await writeFile(join(stateHome, "ESCAPED.md"), "- [ ] Foreign\n")
    store = openBoulderStore(stateHome, { projectRoot })
    const inside = store.start("s1", join(projectRoot, "PLAN.md"))
    expect(inside.plan).toBe("PLAN.md")
    expect(store.get("s1")?.id).toBe(inside.id)
    // Even a plan that sits inside the state home is outside the project: the
    // record and plan confinements are independent.
    expect(() => store.start("s2", join(stateHome, "ESCAPED.md"))).toThrow("outside-project")
    expect(store.get("s2")).toBeNull()
  } finally {
    store?.close()
    await rmRetry(stateHome)
    await rmRetry(projectRoot)
  }
})
