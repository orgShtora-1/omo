# ADR 0013: Durable background children

- Status: Accepted (retroactive record; the decision predates this document)
- Date: 2026-10-18

## Context

Background delegations return at admission, not at completion: the parent's tool call settles once the child is admitted, and results are delivered later as completion notifications. The host can interrupt the parent turn at any time — user abort, steering, or restart — and the host has no tool-call timeout, so a background child tied to the initiating tool-call `AbortSignal` would be killed by an interrupt that has nothing to do with the child's own work.

The code carries this decision in `src/runtime.ts`: background tasks are scheduled with a detached signal, and the `session.execution.interrupted` event handler filters cancellation to foreground children.

## Decision

- **Background delegations run on a detached signal** that the interrupt path never aborts. An interrupted parent turn must not cancel durable child work.
- `session.execution.interrupted` cancels only the interrupted session's **foreground** children (`background: false`).
- Durable reconciliation at mount — journal plus host inspection, never the event stream — adopts and supervises running background children after a host restart.

## Consequences

Background children survive parent interruption and host restarts, and their results still arrive through the notification batcher. Foreground work remains promptly cancellable. Because interrupts no longer reap background work, background capacity relies on the admission and staleness bounds recorded in ADR 0016.
