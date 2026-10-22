# ADR 0003: Skills MCP 1.1.0 adoption

- Status: Accepted
- Date: 2026-10-17

## Context

`@hallaxius/skills` 1.1.0 added five local skill management tools (`list_installed_skills`, `check_skill_updates`, `install_skill`, `update_skill`, `remove_skill`) gated by a server-side mutation switch (`SKILLS_ALLOW_MUTATIONS`) and a preview plus confirmation-token flow. The comparison research in `docs/research/hallaxius-skills-update-2026-10-17.md` verified the published tarball against the GitHub HEAD and mapped the OmO integration: OmO launched the server through unpinned package-runner selectors (`bunx @hallaxius/skills`, `npx -y`, `yarn dlx`, `pnpm dlx`), so the running version depended on the runner cache. The user approved implementing the resulting P0/P1 roadmap.

## Decision

OmO pins and adopts the new capabilities as follows:

- **Exact pin.** `skillsMcpCommand` launches `@hallaxius/skills@1.1.0` for every package manager. The pin names the version OmO reviewed and smoke-tested; a pinned direct selector does not freeze transitive ranges (`zod`, `@modelcontextprotocol/sdk`), which remains a documented reproducibility limitation of runner-based MCP launches.
- **Safe environment defaults.** The contributed skills preset sets `SKILLS_ALLOW_MUTATIONS="false"` and, when the location directory exists, `SKILLS_PROJECT_ROOT` to the OpenCode location directory. Users override per key through `mcp.servers.skills.environment`: their values win over the defaults while unrelated defaults survive, and a custom `command` still receives the safe defaults unless it overrides them.
- **Contribution observation.** Registration reports a `SkillsContribution` (origin, command, pinned, mutationsEnabled, projectRootConfigured) consumed by the doctor. It carries booleans and the command only, never resolved secret values.
- **Capability check.** The doctor adds `mcp-skills-capability`, derived from the live tool catalog via `ctx.tool.list()`: it attributes tools to the skills server by the host registry's `options.namespace` (raw registry names, e.g. `get_skill`), falling back to the `skills_`-prefixed permission-action form only for legacy entries without a namespace (ADR 0020). It fails when no skills tools are connected or when only the legacy 1.0.0 discovery tools are live (stale runner cache or host restart needed), and reports unexpected catalogs as unknown. It never reads version metadata or secrets, and it skips while the server is absent, disabled, or not connected.
- **Strict auto-install audits.** `skills.strictAudits` (default `false`, preserving historical behavior) makes the auto-installer accept only `pass` audit verdicts; when enabled, `warn` and `unknown` are refused like `fail`.
- **Capability smoke.** `bun run test:skills-capability` installs the pinned package into an isolated sandbox, proves the exact ten-tool catalog, read-only project inventory, `PERMISSION_DENIED` refusals for install/remove while mutations are disabled, absence of lock-file or disk changes, and preview isolation. The host MCP smoke asserts that the environment defaults reach the spawned subprocess and that explicit values beat an inherited `SKILLS_ALLOW_MUTATIONS="true"`.
- **P2 deferred.** Replacing the `skills add` CLI auto-installer with the native 1.1 tools is blocked: the installed SDK 2.0.24 `McpDomain` exposes only `list`, `transform`, and `reload` — no authorized MCP tool invocation. The CLI remains the single writer; revisit when the public SDK exposes an authorized invocation path that preserves host permissions, preview, and cancellation, keeping the CLI for non-GitHub sources.

## Consequences

Mutating skills tools deny by default. Opting in requires the environment flag and remains subject to the host permission rules; the upstream `confirm`/`confirmation_token` proves preview freshness, not human consent, so host-level `permissions` denies are the recommended defense in depth.

The doctor capability check works without registry access and cannot be fooled by version strings, but it observes only connected servers and cannot prove third-party authentication. The capability smoke needs network access to install the pinned package and performs a best-effort GitHub preview probe whose outcome is recorded as evidence, never assumed.
