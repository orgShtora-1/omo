type HashlineOp = "replace" | "append" | "prepend"

export type RawHashlineEdit = {
  op: string
  pos?: string
  end?: string
  lines?: string[] | string | null
}

export type HashlineEdit = {
  op: HashlineOp
  pos?: string
  end?: string
  lines: string[]
}

const OPS = new Set<string>(["replace", "append", "prepend"])

/** Parse RawHashlineEdit[] into typed edits, rejecting malformed input with edit indices. */
export function normalizeEdits(raw: RawHashlineEdit[]): HashlineEdit[] {
  return raw.map((edit, index) => {
    if (!OPS.has(edit.op)) {
      throw new Error(
        `Edit ${index}: unsupported op "${edit.op}". Legacy format was removed; use op/pos/end/lines.`,
      )
    }
    const op = edit.op as HashlineOp
    const pos = edit.pos?.trim() || undefined
    const end = edit.end?.trim() || undefined
    if (op === "replace" && !pos && !end) {
      throw new Error(
        `Edit ${index}: replace requires at least one anchor line reference (pos or end)`,
      )
    }
    if (edit.lines === undefined) {
      throw new Error(`Edit ${index}: lines is required for ${op}`)
    }
    const lines =
      edit.lines === null
        ? []
        : Array.isArray(edit.lines)
          ? [...edit.lines]
          : edit.lines.split("\n")
    return { op, pos, end, lines }
  })
}
