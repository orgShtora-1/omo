# ADR 0018: Plugin SDK pin parity with the host

- Status: Accepted
- Date: 2026-10-18

## Context

The managed host runs opencode v2.0.32 while the package pinned `@opencode/plugin` 2.0.24 (2026-10-06) — eight minor versions of drift. Verification against the published SDK found the `SessionDomain` surface byte-identical between 2.0.24 and 2.0.32 (the delegation-relevant APIs `session.prompt`, `session.wait`, `session.get`, `session.create` are unchanged), with additive changes elsewhere: a `./runtime` export, `ctx.permission.assert` (2.0.29), and Effect/runtime dependency bumps. Host-side releases in the range hardened exactly the paths OmO depends on: 2.0.28 converts rejected promise-based plugin tools into normal tool failures instead of crashing their execution path, and raises the default streamed-chunk timeout. The upstream authority is github.com/anomalyco/opencode (renamed from sst/opencode); v2 specs live under `specs/v2/`.

## Decision

- **Pin exactly, at host parity.** `@opencode/plugin` is pinned to `2.0.32`, matching the managed host minor. The pin stays exact (no range): the SDK is compiled against the host's wire and type surface, and an exact pin makes host/plugin drift visible at install time instead of at runtime.
- **Verify parity on host updates.** When the host minor changes, diff the SDK's published types for the domains OmO consumes (`session`, `tool`, `permission`, `agent`, `skill`) before bumping; byte-identical surfaces make bumps mechanical.
- **Live test models follow the catalog.** The dead default `opencode/muse-spark-1.3-contributor-free` (removed from the host catalog; `provider.no-route`) is replaced by `opencode/deepseek-v4.1-flash-free` in all nine live tests; `OMO_LIVE_MODEL` overrides remain available so tests never depend on one provider's survival.

## Consequences

Type-level parity is proven by `tsc --noEmit` against 2.0.32. Semantics OmO relies on — `session.prompt` resolves at inbox admission (never at run completion), `session.wait` resolves on process-local idle and never rejects, `outcome` is absent until terminal transition — are stable across the range and documented in ADR 0013 and 0016 designs. The exact pin means host minors outpace the plugin between releases; that is the accepted trade for reproducible builds, and the live-test default model remains a catalog dependency to re-verify when the host updates.
