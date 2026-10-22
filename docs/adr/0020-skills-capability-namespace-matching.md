# ADR 0020: Skills capability check matches the host registry namespace

- Status: Accepted
- Date: 2026-10-18

## Context

`mcp-skills-capability` (ADR 0003) selected skills tools from the live registry (`ctx.tool.list()`) by filtering names with the `skills_` prefix. On host CLI 2.0.32 this check failed permanently — four live reproductions showed `fail {origin: "absent", tools: 0}` while the sibling `mcp-skills` check reported the server connected with the full ten-tool catalog, degrading every doctor report to `degraded`.

The prefix matched the **permission-action** naming, not the registry naming. Host source (`packages/core/src/tool/mcp.ts`, identical at `v2.0.32` and `dev`) registers MCP tools in the tool registry under their **raw** names (`get_official_skills`) and attributes the owning server through `Tool.Info.options.namespace` (`"skills"`); the composed `<server>_<tool>` string is only ever the permission action. The filter could never match — an inverted premise, not a race or a caching problem.

A second confusion compounded the report: `registration.skills` origin `"absent"` read like a missing server. That value is a snapshot taken when the plugin wires the doctor (src/index.ts) from the contribution captured inside the `ctx.mcp.transform` callback; on hosts that define `skills` in `opencode.jsonc` (or when the host has not yet invoked the transform), the snapshot stays `"absent"` even though the server is live. Origin describes OmO's contribution, never server health.

## Decision

- **Namespace-first matching.** The check selects tools whose registry entry carries `options.namespace === "skills"` and compares their raw names against the canonical catalog `SKILLS_MCP_SERVER_TOOLS` (the ten names `@hallaxius/skills@1.1.0` advertises). A unit tripwire test keeps `SKILLS_MCP_TOOLS` (the prefixed permission-action forms) in sync with the raw catalog.
- **Legacy fallback.** Entries with **no** namespace attribution are unwrapped when their name starts with `skills_` (older hosts keyed tools by the composed name), preserving backward compatibility. Attribution is authoritative: a raw or prefixed name owned by another server never counts, so another server exposing `get_skill` cannot produce a false pass.
- **Exact membership.** Comparison is exact set membership — `get_skill` is a prefix of `get_skill_audits`, so substring matching is forbidden.
- **`ToolLike` carries `namespace`.** `host.ts` extracts `options.namespace` defensively from untrusted registry entries (malformed values are dropped, entries without a valid name are skipped).
- **Self-contained observed record.** Post-connection outcomes report `server: "connected"` alongside `origin`, so an informational origin of `"absent"` or `"host"` can never read as a missing server. Server existence still comes from `ctx.mcp.list`; tool ownership from the registry namespace.

## Consequences

A healthy host 2.0.32 environment now passes with `tools: 10, server: "connected"` and the doctor reports `ok`. Verified end-to-end on a real isolated host: packed tarball installed into a sandbox project whose `opencode.jsonc` defines the skills server (the reported scenario), `omo-doctor` executed through the host API — the capability check passed with `origin: "absent"` present in the same record, proving origin is no longer load-bearing.

The check stays capability-based: no version metadata, no secrets, skip while absent/disabled/disconnected, fail on an empty or 1.0.0-only catalog, unknown on unexpected catalogs. Hosts without namespace attribution keep working through the prefixed fallback. The contribution origin remains a fact about what OmO registered — `"host"` means the host already defined the server and OmO left it alone, `"absent"` means the snapshot predates the registration transform — and neither is a health signal.
