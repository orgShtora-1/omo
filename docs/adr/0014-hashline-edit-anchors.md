# ADR 0014: Hashline edit anchors

- Status: Accepted (retroactive record; the decision predates this document)
- Date: 2026-10-18

## Context

Line-number-based edits silently corrupt files when the content moved between read and write: concurrent sessions, format-on-save or an intervening model turn all shift lines. `omo_hashline_edit` therefore anchors every edit to a content hashline, and the application order of mixed replace/insert batches on shared anchors must be deterministic.

The code carries this decision in `src/hashline/edit.ts` (`applyHashlineEdits`).

## Decision

- Edits are anchored to content hashlines and validated up front (`assertLineRefs`); a stale file fails closed instead of being edited.
- A mixed batch applies **bottom-up by original index**, with inserts keyed at `insert − 0.5` so an insert runs before replaces above it and after replaces on its own anchor line.
- Identical operations are deduplicated; overlapping ranges — replace/replace overlaps and inserts landing inside a replaced range — are rejected with an error that names the conflicting line.
- A blank 1:1 replacement line inherits the replaced line's indentation.

## Consequences

Anchors cannot shift mid-flight, because every operation is placed before the first write. Stale or racing edits fail closed with an actionable error rather than corrupting the file. The same anchor line can host a replace and inserts in a single deterministic batch.
