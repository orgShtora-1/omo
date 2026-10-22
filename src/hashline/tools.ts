import { readFile, rename, rm } from "node:fs/promises"
import type { Plugin } from "@opencode/plugin"
import { writeAtomic } from "./atomic"
import { applyHashlineEdits } from "./edit"
import { normalizeEdits, type RawHashlineEdit } from "./normalize"

const DESCRIPTION =
  "Edit a file by LINE#ID anchors (line#hash) from a previous read. Each edit is " +
  '{op: "replace"|"append"|"prepend", pos?: "N#HH", end?: "N#HH", lines: string[]}. ' +
  'Example: {"op": "replace", "pos": "1#AB", "lines": ["new content"]}. lines is ' +
  "always required; replace needs pos or end. Rejects stale hashes (file changed " +
  "since read); use the updated references from the error. delete:true removes the " +
  "file; rename moves it."

type EditInput = {
  filePath: string
  edits?: RawHashlineEdit[]
  delete?: boolean
  rename?: string
}

function buildDiff(before: string[], after: string[]): string {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }
  const removed = before.slice(start, endBefore)
  const added = after.slice(start, endAfter)
  if (!removed.length && !added.length) return ""
  const hunk = `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`
  return [hunk, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n")
}

/**
 * Register the hash-anchored edit tool (gated by `hashline_edit`). Read pairing:
 * mountToolGuards tags Read output with LINE#ID hashes when the same flag is on.
 */
export async function mountHashline(
  ctx: Plugin.Context,
  enabled: boolean,
): Promise<() => Promise<void>> {
  if (!enabled) return async () => {}
  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omo", description: "OmO custom tools" })
    if (editor.get("omo_hashline_edit"))
      throw new Error("hashline edit tool collision: omo_hashline_edit")
    editor.add({
      name: "hashline_edit",
      description: DESCRIPTION,
      options: { namespace: "omo", permission: "edit" },
      output: {},
      input: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path of the file to edit" },
          edits: {
            type: "array",
            description: "Edits anchored to LINE#ID references from a previous read",
            items: { type: "object" },
          },
          delete: { type: "boolean", description: "Delete the file instead of editing" },
          rename: { type: "string", description: "Rename the output path after edits" },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
      async execute(input) {
        const args = input as EditInput
        if (args.delete === true) {
          await rm(args.filePath, { force: true })
          return { output: `File deleted: ${args.filePath}` }
        }
        const original = await readFile(args.filePath, "utf8")
        const before = original.split("\n")
        const after = applyHashlineEdits(before, normalizeEdits(args.edits ?? []))
        const changed = after.join("\n")
        if (changed !== original) await writeAtomic(args.filePath, changed)
        if (args.rename) await rename(args.filePath, args.rename)
        const target = args.rename ?? args.filePath
        const diff = buildDiff(before, after)
        return {
          output: `Applied ${args.edits?.length ?? 0} edit(s) to ${target}${diff ? `\n${diff}` : ""}`,
        }
      },
    })
  })
  return async () => registration.dispose()
}
