# ADR 0021: Product rename to the Shtora namespace

- Status: Accepted
- Date: 2026-10-21

## Context

The npm organization that publishes OmO is now `shtora` (the former `@hallaxius` scope is no longer resolvable for either `@hallaxius/omo` or `@hallaxius/skills`), and the GitHub organization is `orgShtora-1`. The product still carried the old scope in its package identity, in its plugin and state identifiers, and in the pinned Skills MCP package, so installations and documentation pointed at names that no longer publish.

Three kinds of `hallaxius` existed in the tree and they do not share a migration rule:

- **Package identity.** `@hallaxius/omo` in `package.json`, `bun.lock`, README badges and install commands, `examples/opencode.jsonc`, `AGENTS.md`, `docs/PRODUCT-SPEC.md`, `docs/SKILLS.md`, `LICENSE` and the package smoke scripts.
- **Runtime identifiers.** The plugin id `hallaxius.omo`, the memory/state/teams/worktrees scope keys, the TUI ids `hallaxius.omo.cli` and `hallaxius.omo.tasks`, and the tool-guard messages. These are persisted data keys, not just labels.
- **External references.** The pinned Skills MCP `@hallaxius/skills@0.1.0`, the dated research record in `docs/research/hallaxius-skills-update-2026-10-17.md`, and absolute Windows paths in live tests and fixtures that name the on-disk project folder.

## Decision

- **Single scope everywhere.** The package is `@shtora/omo`, the author is `shtora`, and the copyright holder is Shtora. README, product spec, skills doc, examples, lockfile and package smoke scripts follow the same scope.
- **Runtime identifiers renamed.** Plugin id becomes `shtora.omo`; state and memory scopes become `shtora.omo`, `shtora.omo.memory`, `shtora.omo.teams` and `shtora.omo.worktrees`; TUI ids become `shtora.omo.cli` and `shtora.omo.tasks`; tool-guard messages carry the new id. Source and the tests that assert those strings move together.
- **Skills pin renamed.** `skillsMcpCommand` pins `@shtora/skills@0.1.0`, and `isPinnedSkillsCommand` accepts only that scope.
- **Versions reset to 0.1.0.** Both packages restart their version line at `0.1.0` under the new scope. The Skills MCP keeps its full tool catalog, including local management, so prose and doctor remediation now describe capability (discovery-only legacy catalog versus full catalog) instead of the retired `1.0.0`/`1.1.0` numbers.
- **Skills repository renamed in place.** `orgShtora-1/skills` carries the same rename: package name, author, copyright, homepage, repository and issue URLs, README install snippets, server version and GitHub user agent all say `shtora`. Snippets and fixtures using the `Hallaxius` GitHub organization move to `orgShtora-1`.
- **Historical records keep the old scope.** ADRs 0003 and 0020 and the dated research document describe artifacts that were published, reviewed and linked under `Hallaxius`; rewriting their URLs or commit references would falsify evidence. They are superseded on naming by this ADR.
- **Filesystem paths are not package names.** The absolute `.../GitHub/OmO/hallaxius/omo` path in the live tests and in `test/fixtures/agents-probe-project/opencode.jsonc` still points at the real directory and is left untouched. Renaming that folder is a separate, explicit operation.

## Consequences

State continuity is deliberately broken: plans, memory, teams and worktree records written under `hallaxius.*` keys are not discovered by a `shtora.omo` install, so an existing installation starts with empty state unless the keys are migrated by hand. `README` documents this in the beta migration note.

At the time of writing, neither `@shtora/omo` nor `@shtora/skills` resolves in the public registry, so the rename fixes the identity but does not by itself make the pinned skills server installable; publication of both packages under the new scope is required before `bun run test:skills-capability` can pass. `package.json` now points `repository`, `homepage` and `bugs` at `https://github.com/orgShtora-1/omo`; that repository does not exist yet, so those links stay unresolved until it is created and pushed.

Evidence files emitted by the smoke scripts now use the `shtora-omo-*` prefix; older `hallaxius-omo-*` evidence remains valid for the runs that produced it.
