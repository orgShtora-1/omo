# ADR 0019: Native subagent rendering is a host concern

- Status: Accepted
- Date: 2026-10-18

## Context

The V2 CLI renders the subagent tool heading as `<agent ID> Subagent — description`. OmO's profiles carry richer identities than that heading exposes, and a styled heading (reordered text, colored name) was considered. The inspected CLI versions `2.0.27`–`2.0.32` show the same behavior, and the installed plugin SDK provides no scoped hook to reorder the heading or color only the name — the render belongs to the host's tool pipeline, not to plugin tool definitions.

This record replaces a dangling README reference to `docs/adr/0003-native-subagent-rendering.md`; numbering follows the in-repo references (records 0004–0011 do not exist in this workspace).

## Decision

- **Accept host-owned rendering.** OmO does not patch, wrap or spoof host UI text for the subagent heading.
- OmO's own progress surfaces stay native and additive: `ToolContext.progress` reports child `sessionID` and status, and delegation tool results carry `metadata.sessionID` / `metadata.sessionIDs` (ADR 0015). The host TUI renders its own child tabs from those signals.

## Consequences

Subagent headings stay visually identical to host-native subagents, which keeps the experience consistent and avoids fighting the host pipeline. Cosmetic restyling is deferred until the host exposes a scoped hook; if that never happens, this stays closed by design.
