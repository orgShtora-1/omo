# ADR 0015: Live child progress and metadata surfacing

- Status: Accepted
- Date: 2026-10-18

## Context

While an `omo_delegate`, `omo_parallel` or `omo_consult` tool call was pending, the host TUI showed only a generic spinner for the tool call itself. The TUI discovers delegated child sessions from (a) `context.progress` updates carrying `{sessionID, status}` and (b) the `metadata` field projected from the tool's returned `Tool.Result`. OmO used neither: tool outputs were JSON round-tripped into `output` with no `metadata`, and the `ToolContext.progress` callback was never invoked, so the user had no visible child surface while a turn was waiting on delegation work. The plugin SDK exposes `Tool.Result.metadata` and `ToolContext.progress` since the tool schema the host already runs (verified against `@opencode/schema` shipped with the installed plugin SDK).

## Decision

- **Progress on admission and completion.** The plan tool wrappers now thread the host `ToolContext.progress` callback into every delegation handler. `omo_delegate` and `omo_consult` report `{sessionID: handle.sessionID, status: childStatus(handle)}` once the runtime resolves (child admitted, or completed for foreground work); `omo_parallel` reports each handle. Failures to report progress are swallowed (`.catch`): progress is advisory rendering, never a functional dependency.
- **Metadata projection.** `omo_delegate`/`omo_consult` return `metadata: {sessionID}` and `omo_parallel` returns `{sessionID: first, sessionIDs: [...]}` so the TUI's child discovery can list every delegated child from the projected tool output, not just the ones observed live.
- **JSON round-trip preserved.** Structured output remains JSON (the host serializes tool output for the model); `metadata` is additive on top of the existing `output`/`content` shape.
- **Signal propagation.** The wrapper forwards `context.signal` as the tool abort signal, unchanged in semantics.

## Consequences

The TUI renders one child footer tab per delegated child and a detail transcript while the parent turn is in flight, restoring the delegation observability lost on Windows (where the tmux monitor path is inert). Metadata keys are additive and ignored by hosts or clients that do not project them. Progress calls that race with turn end are harmless no-ops.
