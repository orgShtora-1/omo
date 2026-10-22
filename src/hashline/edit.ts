import type { HashlineEdit } from "./normalize"
import { assertLineRefs, parseLineRef } from "./validation"

type Span = { op: HashlineEdit["op"]; start: number; end: number; insert: number }

function indentationOf(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? ""
}

/**
 * Apply normalized hashline edits: validate anchors, dedup, reject overlaps,
 * then apply bottom-up by original index so anchors never shift mid-flight.
 * Blank 1:1 replacement lines inherit the replaced line's indentation.
 */
export function applyHashlineEdits(lines: string[], edits: HashlineEdit[]): string[] {
  const anchors: string[] = []
  for (const edit of edits) {
    if (edit.pos) anchors.push(edit.pos)
    if (edit.end && edit.end !== edit.pos) anchors.push(edit.end)
  }
  assertLineRefs(lines, anchors)

  const spanOf = (edit: HashlineEdit): Span => {
    const posLine = edit.pos ? parseLineRef(edit.pos).line : undefined
    const endLine = edit.end ? parseLineRef(edit.end).line : undefined
    if (edit.op === "replace") {
      const start = (posLine ?? endLine ?? 1) - 1
      const end = (endLine ?? posLine ?? 1) - 1
      return { op: edit.op, start, end, insert: start }
    }
    const anchor = posLine ?? endLine
    if (edit.op === "append") {
      // After the anchor line (0-based index == anchor); no anchor = EOF, which
      // sits before the trailing-newline sentinel produced by split("\n").
      const atEnd = lines.length > 0 && lines[lines.length - 1] === ""
      const insert = anchor ?? (atEnd ? lines.length - 1 : lines.length)
      return { op: edit.op, start: insert, end: insert - 1, insert }
    }
    // Prepend before the anchor line; no anchor = BOF.
    const insert = anchor ? anchor - 1 : 0
    return { op: edit.op, start: insert, end: insert - 1, insert }
  }

  // Inserts key at (insert - 0.5) so they run before replaces above them
  // and after replaces on their own anchor line (see ADR-0014).
  const keyOf = (edit: HashlineEdit, span: Span): number =>
    edit.op === "replace" ? span.start : span.insert - 0.5
  const entries = edits.map((edit) => {
    const span = spanOf(edit)
    return { edit, span, key: keyOf(edit, span) }
  })

  // Dedup identical operations before overlap detection.
  const seen = new Set<string>()
  const unique: Array<{ edit: HashlineEdit; span: Span; key: number }> = []
  for (const entry of entries) {
    const identity = JSON.stringify({
      op: entry.span.op,
      start: entry.span.start,
      end: entry.span.end,
      insert: entry.span.insert,
      lines: entry.edit.lines,
    })
    if (seen.has(identity)) continue
    seen.add(identity)
    unique.push(entry)
  }

  const replaces = unique.filter((entry) => entry.span.op === "replace")
  for (const [left, first] of replaces.entries()) {
    for (const second of replaces.slice(left + 1)) {
      if (first.span.start <= second.span.end && second.span.start <= first.span.end) {
        throw new Error(
          `Overlapping edit ranges detected: line ${second.span.start + 1} is claimed by multiple edits`,
        )
      }
    }
    for (const inserted of unique.filter((entry) => entry.span.op !== "replace")) {
      const point = inserted.span.insert
      if (first.span.start < point && point <= first.span.end) {
        throw new Error(
          `Overlapping edit ranges detected: insert at line ${point + 1} falls inside a replaced range`,
        )
      }
    }
  }

  const working = [...lines]
  const ordered = [...unique].sort((left, right) => right.key - left.key)

  for (const { edit, span } of ordered) {
    if (edit.op === "replace") {
      const original = working.slice(span.start, span.end + 1)
      let replacement = edit.lines
      if (replacement.length === original.length) {
        const indent = original.map(indentationOf)
        replacement = replacement.map((line, index) =>
          /^\s*$/.test(line) ? (indent[index] ?? "") : line,
        )
      }
      working.splice(span.start, span.end - span.start + 1, ...replacement)
      continue
    }
    working.splice(span.insert, 0, ...edit.lines)
  }

  return working
}
