import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openBoulderStore } from "../../src/boulder/store"

test("boulder ownership and progress survive reopening the project store", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-boulder-"))
  try {
    await writeFile(join(root, "plan.md"), "- [x] First\n- [ ] Ship\n")
    const store = openBoulderStore(root)
    const work = store.start("owner", "plan.md")
    expect(work.status).toBe("active")
    expect(openBoulderStore(root).get("owner")).toEqual(work)
    expect(store.get("other-session")).toBeNull()
    expect(store.progress("owner")?.next).toEqual({ line: 2, label: "Ship" })
    await writeFile(join(root, "plan.md"), "- [x] First\n- [x] Ship\n")
    expect(store.progress("owner")?.remaining).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("boulder rejects escaped plans and missing identity without replacing current work", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-boulder-"))
  const outside = await mkdtemp(join(tmpdir(), "omo-boulder-outside-"))
  try {
    await writeFile(join(root, "plan.md"), "- [ ] Ship")
    await writeFile(join(outside, "plan.md"), "- [ ] Foreign")
    const store = openBoulderStore(root)
    const initial = store.start("owner", "plan.md")
    expect(() => store.start("owner", join(outside, "plan.md"))).toThrow("outside-project")
    expect(() => store.start(" ", "plan.md")).toThrow("native-session-required")
    expect(store.get("owner")).toEqual(initial)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("boulder terminal work cannot resume and paused work requires explicit resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-boulder-"))
  try {
    await writeFile(join(root, "plan.md"), "- [ ] Ship")
    const store = openBoulderStore(root)
    store.start("owner", "plan.md")
    expect(store.transition("owner", "paused")?.status).toBe("paused")
    expect(openBoulderStore(root).get("owner")?.status).toBe("paused")
    expect(store.transition("owner", "active")?.status).toBe("active")
    expect(store.transition("owner", "completed")?.status).toBe("completed")
    expect(() => store.transition("owner", "active")).toThrow("terminal-work")
    expect(store.get("owner")?.status).toBe("completed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("boulder keeps records in the state home and plan documents in the project root", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "omo-boulder-state-"))
  const projectRoot = await mkdtemp(join(tmpdir(), "omo-boulder-project-"))
  try {
    await writeFile(join(projectRoot, "PLAN.md"), "- [ ] Ship\n")
    const store = openBoulderStore(stateHome, { projectRoot })
    const work = store.start("s1", "PLAN.md")
    expect(work.plan).toBe("PLAN.md")
    // The session record lives under the state home, never inside the project.
    const record = join(
      stateHome,
      "boulder",
      `${createHash("sha256").update("s1").digest("hex")}.json`,
    )
    const stored = JSON.parse(await readFile(record, "utf8")) as {
      works: Array<{ plan: string }>
    }
    expect(stored.works).toHaveLength(1)
    expect(stored.works[0]?.plan).toBe("PLAN.md")
    expect(
      await readFile(
        join(projectRoot, "boulder", `${createHash("sha256").update("s1").digest("hex")}.json`),
        "utf8",
      ).catch(() => null),
    ).toBeNull()
    // Progress reads the plan document from the project root.
    expect(store.progress("s1", work.id)?.remaining).toBe(1)
  } finally {
    await rm(stateHome, { recursive: true, force: true })
    await rm(projectRoot, { recursive: true, force: true })
  }
})

test("boulder accepts absolute plans inside the project root and refuses ones outside it", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "omo-boulder-state-"))
  const projectRoot = await mkdtemp(join(tmpdir(), "omo-boulder-project-"))
  try {
    await writeFile(join(projectRoot, "PLAN.md"), "- [x] Done\n")
    await writeFile(join(stateHome, "ESCAPED.md"), "- [ ] Foreign\n")
    const store = openBoulderStore(stateHome, { projectRoot })
    const inside = store.start("s1", join(projectRoot, "PLAN.md"))
    expect(inside.plan).toBe("PLAN.md")
    expect(store.get("s1")?.id).toBe(inside.id)
    // Even a plan that sits inside the state home is outside the project: the
    // record and plan confinements are independent.
    expect(() => store.start("s2", join(stateHome, "ESCAPED.md"))).toThrow("outside-project")
    expect(store.get("s2")).toBeNull()
  } finally {
    await rm(stateHome, { recursive: true, force: true })
    await rm(projectRoot, { recursive: true, force: true })
  }
})
