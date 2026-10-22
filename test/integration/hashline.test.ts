import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { parseOptions } from "../../src/config/schema"
import { computeLineHash } from "../../src/hashline/hash"
import { mountHashline } from "../../src/hashline/tools"
import { mountToolGuards } from "../../src/runtime/tool-guards"

type AfterHook = (input: Record<string, unknown>) => unknown

type ToolRecord = {
  name: string
  description: string
  options: { namespace?: string; permission?: string }
  input: Record<string, unknown>
  output: unknown
  execute(input: Record<string, unknown>, context: unknown): Promise<unknown> | unknown
}

function fixture() {
  const afterHooks: AfterHook[] = []
  const added: ToolRecord[] = []
  const ctx = {
    tool: {
      hook(name: string, fn: AfterHook) {
        if (name === "execute.after") afterHooks.push(fn)
        return { dispose() {} }
      },
      async transform(editor: (editor: unknown) => unknown | Promise<unknown>) {
        const target = {
          namespace() {},
          get() {
            return undefined
          },
          update() {},
          add(record: ToolRecord) {
            added.push(record)
          },
        }
        await editor(target)
        return { dispose() {} }
      },
    },
  }
  return { ctx: ctx as unknown as Plugin.Context, afterHooks, added }
}

function readCompleted(output: string) {
  return {
    tool: "read",
    sessionID: "ses_test",
    agent: "executor",
    messageID: "msg_test",
    id: "call_test",
    input: {},
    status: "completed",
    result: { output },
  }
}

function first<T>(items: readonly T[], what: string): T {
  const head = items[0]
  if (head === undefined) throw new Error(`expected ${what}`)
  return head
}

test("hashline_edit defaults to false and accepts an explicit boolean", () => {
  expect((parseOptions({ schemaVersion: 1 }) as { hashline_edit?: boolean }).hashline_edit).toBe(
    false,
  )
  expect(
    (parseOptions({ schemaVersion: 1, hashline_edit: true }) as { hashline_edit?: boolean })
      .hashline_edit,
  ).toBe(true)
  expect(() => parseOptions({ schemaVersion: 1, hashline_edit: "yes" })).toThrow()
})

test("tool guards hash-tag read outputs only when hashline is enabled", async () => {
  const enabled = fixture()
  const disposeEnabled = await mountToolGuards(enabled.ctx, true)
  expect(enabled.afterHooks).toHaveLength(1)
  const input = readCompleted("1: alpha\n2: beta") as Record<string, unknown>
  await first(enabled.afterHooks, "the mounted after hook")(input)
  const result = input.result as { output: string }
  expect(result.output).toBe(
    `1#${computeLineHash(1, "alpha")}|alpha\n2#${computeLineHash(2, "beta")}|beta`,
  )
  disposeEnabled()

  const disabled = fixture()
  const disposeDisabled = await mountToolGuards(disabled.ctx)
  const untouched = readCompleted("1: alpha\n2: beta") as Record<string, unknown>
  await first(disabled.afterHooks, "the mounted after hook")(untouched)
  expect((untouched.result as { output: string }).output).toBe("1: alpha\n2: beta")
  disposeDisabled()
})

test("tool guards tag host-shaped read output with a leading header", async () => {
  const enabled = fixture()
  const dispose = await mountToolGuards(enabled.ctx, true)
  // Live hosts prefix native reads with a human header line (observed in the
  // hashline-permission live probe); the header must pass through verbatim
  // while the numbered lines below still receive LINE#ID anchors.
  const header = "Read file /tmp/notes.txt, lines 1-3"
  const input = readCompleted(`${header}\n1: alpha\n2: beta`) as Record<string, unknown>
  await first(enabled.afterHooks, "the mounted after hook")(input)
  expect((input.result as { output: string }).output).toBe(
    `${header}\n1#${computeLineHash(1, "alpha")}|alpha\n2#${computeLineHash(2, "beta")}|beta`,
  )
  dispose()
})

test("truncation guard still applies when hashline is enabled", async () => {
  const f = fixture()
  const dispose = await mountToolGuards(f.ctx, true)
  const oversized = "x".repeat(150_000)
  const input = {
    tool: "bash",
    sessionID: "ses_test",
    agent: "executor",
    messageID: "msg_test",
    id: "call_test",
    input: {},
    status: "completed",
    result: { output: oversized },
  } as unknown as Record<string, unknown>
  await first(f.afterHooks, "the mounted after hook")(input)
  const output = (input.result as { output: string }).output
  expect(output.length).toBeLessThan(oversized.length)
  expect(output).toContain("[output truncated by shtora.omo tool guard]")
  dispose()
})

test("hashline edit tool registers only when enabled", async () => {
  const enabled = fixture()
  const disposeEnabled = await mountHashline(enabled.ctx, true)
  expect(enabled.added).toHaveLength(1)
  const record = first(enabled.added, "the hashline_edit registration")
  expect(record.name).toBe("hashline_edit")
  expect(record.options.permission).toBe("edit")
  expect(record.input).toMatchObject({
    type: "object",
    required: ["filePath"],
  })
  disposeEnabled()

  const disabled = fixture()
  const disposeDisabled = await mountHashline(disabled.ctx, false)
  expect(disabled.added).toHaveLength(0)
  disposeDisabled()
})

test("hashline edit executes anchored replace, rename and delete", async () => {
  const f = fixture()
  const dispose = await mountHashline(f.ctx, true)
  const record = first(f.added, "the hashline_edit registration")
  const directory = await mkdtemp(join(tmpdir(), "omo-hashline-"))
  try {
    const file = join(directory, "a.ts")
    await writeFile(file, "const a = 1\nconst b = 2\n")
    const before = (await readFile(file, "utf8")).split("\n")

    const result = (await record.execute(
      {
        filePath: file,
        edits: [
          {
            op: "replace",
            pos: `1#${computeLineHash(1, before[0] ?? "")}`,
            lines: ["const aa = 1"],
          },
          { op: "append", lines: ["const c = 3"] },
        ],
      },
      {},
    )) as { output: string }
    expect(await readFile(file, "utf8")).toBe("const aa = 1\nconst b = 2\nconst c = 3\n")
    expect(result.output).toContain("-const a = 1")
    expect(result.output).toContain("+const aa = 1")

    const renamed = join(directory, "b.ts")
    await record.execute({ filePath: file, edits: [], rename: renamed }, {})
    expect(await readFile(renamed, "utf8")).toBe("const aa = 1\nconst b = 2\nconst c = 3\n")
    await expect(stat(file)).rejects.toThrow()

    await record.execute({ filePath: renamed, edits: [], delete: true }, {})
    await expect(stat(renamed)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
    dispose()
  }
})
