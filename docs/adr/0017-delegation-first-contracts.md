# ADR 0017: Delegation-first contracts

- Status: Accepted
- Date: 2026-10-18

## Context

Primary agents (sisyphus, hephaestus, atlas) retained full direct capabilities while delegation guidance was advisory one-liners. Models rationally self-served: fetching registry URLs directly in the parent turn instead of routing them to `librarian`, searching the repository themselves instead of `explore`. This duplicated work, hid the evidence trail in the parent transcript, and for `omo_parallel`-shaped work serialized what should have been concurrent. The upstream behavioral reference (oh-my-openagent, Sustainable Use License — themes only, no text copied) enforces delegation with layered operating-mode prompts: a mandatory delegation check before direct action, an explicit anti-duplication rule, parallel-first read-only fan-out, and an end-your-turn protocol for background tasks. Upstream also demonstrated that because the standard spawn is background and the parent ends its turn, there is never a long-pending tool call and therefore no perpetual spinner.

## Decision

- **Teaching tool descriptions.** `omo_delegate`, `omo_parallel` and `omo_consult` descriptions now state when to use the tool, prefer it over doing the work in the parent turn, enumerate the specialist roster (`explore` for codebase questions, `librarian` for external documentation, `executor`/`sisyphus-junior` for implementation, `reviewer`/`verifier` for checks, `oracle` for advice), require concrete question + owned scope + observable exit criterion, and instruct the end-turn protocol: background delegations return on admission, the model reports what was delegated and ends the turn, and completion notifications deliver the evidence.
- **Delegation check in the shared contract.** `delegatingContract` (appended to every primary) adds: run the delegation check before substantive work and delegate by default when a specialist covers the task; never duplicate delegated work — once a specialist owns a search, fetch, review or analysis, wait for their evidence instead of running it yourself.
- **Role-specific operating modes.** sisyphus coordinates: investigation and implementation are delegated work; it acts personally only to integrate, read child evidence and unblock. hephaestus keeps hands-on authority for the cohesive core of a change, but must resolve uncertainty with delegated evidence first (inspect directly only what it is about to edit) and may delegate independent bounded units in parallel. atlas is a conductor that writes assignments, never product code, and never performs a delegated step itself.
- **Original text throughout.** All prompt text is authored for this product; the upstream license permits behavioral reference only.

## Consequences

Direct capability remains available (primaries keep `write` and their permissions) so nothing deadlocks when delegation is unavailable or trivial, but the contracts make self-serving the non-default, explicitly-justified path. Tool descriptions are the primary teaching surface because they are visible to every model at every tool choice, including hosts where agents are configured by the user rather than by the plugin. Enforcement stays advisory at the permission layer for primaries: hard-denying their direct tools would break small tasks and integration work; consultation agents keep their hard denials. The end-turn protocol also removes long-pending foreground waits, complementing ADR 0016's admission bound.
