# Skills integration guide

OmO routes skills from two sources into child delegations and keeps skill installation auditable. This guide is the reference for agents and maintainers working in this repository.

## Where skills come from

- **Host skills** — everything the host reports through `ctx.skill.list` (project `.agents/skills`, host-native and configured skills).
- **Filesystem catalog** — skills discovered from the project's `.agents/skills` directory, so a skill that exists on disk is usable even when the host has not listed it yet.

Both sources are merged and deduplicated at delegation time.

## Resolution at delegation time

Every `omo_delegate` / `omo_parallel` / `omo_consult` request resolves skills before admission:

1. Merge host skills + filesystem catalog for the project.
2. Score candidates against the task prompt (`scoreSkills`), honoring `skills.recommendedLimit` (default 5) and `skills.required`.
3. Apply the delegation policy (`createDelegationPolicy.resolve`).
4. Filter to **known host skill IDs only** — an unknown skill fails closed with `unknown-skill` rather than degrading silently.
5. Attach the resolved skill set to the child prompt.

## Auto-install coverage

When a clearly matching skill is missing, `ensureSkillCoverage` can install it from skills.sh through the configured `runtime.packageManager` runner (default `bun` → `bunx`). Guards:

- `skills.autoInstall` (default `true`) gates the whole path.
- `skills.requireAuditPass` (default `true`) refuses skills whose audit reports `fail`.
- `skills.strictAudits` (default `false`) additionally refuses `warn` and `unknown` verdicts.
- **An install failure never breaks delegation** — the child proceeds and the outcome records `install-failed`.

The CLI (`skills add`) remains the single writer for local skill installation; see ADR 0003.

## Skills MCP preset

OmO contributes a pinned local Skills MCP server (ADR 0001, ADR 0003):

- `@shtora/skills@0.1.0`, exact reviewed pin, launched by the configured package-manager runner.
- `SKILLS_ALLOW_MUTATIONS=false` by default — install/update/remove refuse with `PERMISSION_DENIED` until opted in via `mcp.servers.skills.environment`.
- `SKILLS_PROJECT_ROOT` points at the OpenCode location directory, so project-scope inventory reads the real project.
- `VERCEL_OIDC_TOKEN` can be passed for authenticated actions through an explicit `{env:...}` mapping; `GITHUB_TOKEN`/`GH_TOKEN` are never forwarded implicitly.

## Doctor check

`omo_doctor` reports a `mcp-skills-capability` check built from the **live tool catalog** (`ctx.tool.list()`), never from version metadata or secret values. Tools are attributed to the skills server by the host registry's `options.namespace` (raw names like `get_skill`); the `skills_`-prefixed form is only a legacy fallback for entries without a namespace — never the primary matcher (ADR 0020). It fails when only the legacy discovery-only catalog is connected (usually a stale package-runner cache or a host that needs a restart) and skips while the server is absent, disabled, or not connected.

## Agent guidance

- Load **only** skills pertinent to the current task — always skills installed in the user's project (project `.agents/skills`, `skills` in `opencode.jsonc`, host-native), never a plugin-side catalog.
- Never invent skill IDs. If a tool does not recognize an installed skill, read `.agents/skills/<name>/SKILL.md` directly.
- Do not install skills from untrusted sources; the audit guards above are the floor, not the ceiling.

## Validation

`bun run test:skills-capability` installs `@shtora/skills@0.1.0` in an isolated sandbox and exercises the ten-tool catalog, read-only inventory, mutation refusals and preview isolation against a temporary project.

## Related decisions

- ADR 0003 — Skills 0.1.0 adoption and the pinned-mutation posture
- ADR 0001 — automatic MCP registration
- ADR 0002 — config-adjacent MCP environment and `.env` handling
