import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openBoulderContext } from "../../src/boulder/context"

async function project(plan = "- [x] Done\n- [ ] Ship\n- [ ] Verify\n") {
  const root = await mkdtemp(join(tmpdir(), "omo-boulder-context-"))
  await writeFile(join(root, "plan.md"), plan)
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test("work context names the live work, its plan progress and the next step", async () => {
  const { root, cleanup } = await project()
  let context: ReturnType<typeof openBoulderContext>
  try {
    context = openBoulderContext(root)
    expect(context.summary("no-work")).toBeNull()
    const work = context.store.start("s", "plan.md")
    const text = context.summary("s")
    expect(text).toContain(work.id)
    expect(text).toContain("plan.md")
    expect(text).toContain("1/3")
    expect(text).toContain("Ship")
    // The newest non-terminal work is the implicit subject of the summary.
    const second = context.store.start("s", "plan.md")
    expect(context.summary("s")).toContain(second.id)
    expect(context.store.transition("s", "completed")?.id).toBe(second.id)
    expect(context.summary("s")).toContain(work.id)
  } finally {
    context?.store.close()
    await cleanup()
  }
})

test("work context is silent for terminal, blank and unreadable-plan work", async () => {
  const { root, cleanup } = await project("- [ ] Ship\n")
  let context: ReturnType<typeof openBoulderContext>
  try {
    context = openBoulderContext(root)
    expect(context.summary("  ")).toBeNull()
    context.store.start("s", "plan.md")
    expect(context.store.transition("s", "abandoned")).not.toBeNull()
    expect(context.summary("s")).toBeNull()
    context.store.start("t", "plan.md")
    await rm(join(root, "plan.md"), { force: true })
    expect(context.summary("t")).toBeNull()
    expect(() => context.store.start("u", "missing.md")).toThrow()
  } finally {
    context?.store.close()
    await cleanup()
  }
})
