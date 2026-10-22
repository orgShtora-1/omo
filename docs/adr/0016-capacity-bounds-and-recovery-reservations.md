# ADR 0016: Capacity bounds and recovery reservations

- Status: Accepted
- Date: 2026-10-18

## Context

Wild state showed delegated children wedged with no terminal outcome (no `outcome`, no `time.idle`) after host restarts or provider hangs: 9 leaked capacity slots across 5 projects, two projects fully saturated. The runtime's recovery loop reserved a `maxChildren` slot for **every** journal record it could not finish — including blocked/intent records with no observable native work and running zombies — and never released it; `observe()` polled such children every 100 ms with no deadline; queued delegations waited for a slot with no admission timeout. Because the host has no tool-call timeout, a saturated project made every `omo_delegate`/`omo_parallel`/`omo_consult` call pend forever: the "infinite loading on all tasks" failure.

## Decision

Two new bounds, both configurable under `execution`:

- **`admissionTimeoutMs` (default 120 000).** A queued scheduler entry that does not start within the budget is rejected with an `admission-timeout: ...` error that names active and queued counts and points to `omo_status`. The timer is cleared when the entry starts or aborts. Waiting on capacity fails fast and actionably instead of hanging the tool call.
- **`staleTimeoutMs` (default 15 min).** `observe()` seeds a child's staleness from the host's own `session.time.updated` (exposed additively by `ExecutionAdapter.inspect`). A child that shows no host update for the budget is cancelled; if cancellation is confirmed the attempt is finished with the terminal state, otherwise it is blocked for explicit reconciliation. Pre-restart zombies die on their first poll; live children are reaped only after a long silent stretch.

Recovery and reservation semantics:

- **No reservation without observable work.** Records without a `sessionID` and blocked/intent records are terminalized or blocked but never reserve capacity; unknown native sessions are blocked without reserving. Only records with a live running session are adopted, reserved and supervised, and only until `finish()` releases them.
- **Adoption failures degrade, not crash.** One bad record at mount can no longer abort recovery for the rest; the record is blocked with the reason and the loop continues.
- **Live-path launch failures never leak slots.** The scheduler's execute error path no longer reserves matching unresolved records; `retrySafe` already pins their `taskID` until explicit reconciliation.
- **Cancel terminalizes everything it matches.** `services.cancel` resolves records with no session, failed adoption and unconfirmed native cancellation to `cancelled` instead of leaving them pinned, so a cancelled parent releases its `taskID`s.

## Consequences

Wedged capacity self-heals at the next per-project mount: zombies are reaped by the staleness bound and unobservable records stop consuming slots. The admission error surfaces scheduler state to the model, so the visible failure becomes a bounded, explained one. A genuinely slow-but-alive child that updates the host session less than once per `staleTimeoutMs` would be reaped; the default is far above observed child activity, and the reap is a host-visible cancellation, never silent data loss. Existing journals need no migration: the new accounting is computed from existing record state.
