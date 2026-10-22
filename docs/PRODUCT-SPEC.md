# OmO product specification

- Package: `@shtora/omo` (npm, `latest` dist-tag)
- Status: 0.1.0 (official), 2026-10-19

## Product definition

OmO is a native [OpenCode V2](https://opencode.ai/v2) plugin that turns the host into an orchestrated agent runtime: durable plans with evidence-gated steps, bounded parallel delegation routed to specialists, read-only consultations, session todos joined with live plan progress, handoff artifacts, bounded memory with dream/time reflection, LSP intelligence with reviewed edits, durable teams, owned worktrees, hashline-anchored edits, and an optional TUI face. Server features work without the TUI.

## Package contract

- **Name:** `@shtora/omo`, MIT, ESM-only, TypeScript.
- **Entries:** the server face at the package root (`server.ts`, `.` export → `dist/index.js`) and the TUI face (`tui.ts`, `./tui` export → `dist/terminal/tui.js`). The host resolves both through `@opencode/plugin/host`.
- **Runtime:** Bun >= 1.4.2 (`engines`); no Node.js support is claimed.
- **Dependencies:** `@opencode/plugin` only, exact-pinned at host parity (ADR 0018). Development tooling is Bun + Biome + `tsc`.
- **Publishing:** `publishConfig` = `access: public`, `tag: latest`. `prepublishOnly` runs the full gate chain (`check` + package + MCP host smokes); `prepack` builds.

## Host contract

The plugin mounts through the public V2 plugin lifecycle (`@opencode/plugin` promise API) and registers:

- **17 agent profiles** — primaries `sisyphus`, `hephaestus`, `prometheus`, `atlas`; subagents `orchestrator`, `planner`, `executor`, `explore`, `researcher`, `reviewer`, `verifier`, `oracle`, `librarian`, `multimodal-looker`, `metis`, `momus`, `sisyphus-junior`. Contracts are delegation-first (ADR 0017); consultation profiles carry hard permission denials.
- **Tools** in the `omo` namespace: plans, status, blocked, revision, doctor, session, boulder, goals, team, worktree, delegate, parallel, consult, command, hashline edit, LSP queries/apply, memory, monitor, compact, todos.
- **Slash commands:** `/omo-plan`, `/omo-status`, `/omo-resume`, `/omo-cancel`, `/omo-compact`, `/omo-doctor`, `/handoff`, `/refactor`, `/deep-ini`, and `/omo-tasks` (TUI).
- **MCP presets** (ADR 0001): `skills`, `github`, `context7` enabled by default; `vercel`, `cloudflare` opt-in. OmO never writes host MCP configuration.
- **Permission guards:** consultation/readonly profiles deny edit+shell; agent model assertions; a `task`-keyed team gate (ADR 0012).

Mount acquires a single-owner project runtime lock; dispose tears down tools, supervision, scheduler and the event loop without cancelling durable background children (ADR 0013).

## Subsystem map

| Area | Purpose |
| --- | --- |
| `src/agents` | Profile registry, contracts, permission restrictions, model policy |
| `src/plans` | Plan tools, plan repository, evidence verification |
| `src/runtime.ts` | Mount lifecycle, delegation services, recovery reconciliation, supervision |
| `src/execution` | Scheduler (capacity, retries), run journal, notifications |
| `src/host` | Execution adapter over the host session port; doctor; events |
| `src/terminal` | Slash commands, tmux monitor (opt-in, POSIX-only), TUI plugin |
| `src/teams`, `src/goals`, `src/memory`, `src/lsp`, `src/hashline`, `src/worktree` | Feature subsystems backing their tools |
| `src/state` | Plans/runs SQLite repositories, home resolution, project lock |
| `src/config` | Schema, parsing, defaults, fail-closed merging |
| `src/skills` | Skill resolution, scoring, auto-install coverage (see [SKILLS.md](./SKILLS.md)) |

## Durable state

Durable state lives under the OmO home (`~/.omo`, `OMO_HOME` can override), isolated by project: `projects/<slug>/` holds `plans.sqlite`, `runs.sqlite`, `teams.sqlite` and `runtime.lock`. Session todos live in the host's plugin KV, scoped to project + directory + session, and are not covered by filesystem backups of the OmO home.

## Configuration

A shared `omo.jsonc` beside the host's user configuration, overridable per project through the plugin entry's `options`. Omitted keys fall back to defaults; corrupt or future-version files are preserved and reported, never overwritten. Annotated example: [`examples/omo.jsonc`](../examples/omo.jsonc).

## Capacity model

At most `execution.maxChildren` (default 3) concurrent children per project, `maxAttempts` (default 3) bounded attempts per assignment. Queued delegations fail fast after `execution.admissionTimeoutMs` (default 120 s); children with no observable host progress for `execution.staleTimeoutMs` (default 15 min) are reaped (ADR 0016). Consultations are strictly read-only.

## Quality gates

- `bun run check` — lint (Biome), build, `tsc --noEmit`, unit + integration suites.
- `bun run test:package` — installs the packed tarball in an isolated project and resolves both public exports.
- `bun run test:mcp-host-package`, `test:host-package`, `test:host-lifecycle`, `test:host-rollback` — tarball-against-host smokes without provider calls.
- `OMO_LIVE=1 bun run test:live` — model-backed live probes against a managed host (delegation and parallel admission, child terminal outcomes).

## ADR index

[0001](./adr/0001-automatic-mcp-registration.md) · [0002](./adr/0002-config-adjacent-mcp-environment.md) · [0003](./adr/0003-skills-1-1-adoption.md) · [0012](./adr/0012-team-task-permission-gate.md) · [0013](./adr/0013-durable-background-children.md) · [0014](./adr/0014-hashline-edit-anchors.md) · [0015](./adr/0015-live-child-progress-surfacing.md) · [0016](./adr/0016-capacity-bounds-and-recovery-reservations.md) · [0017](./adr/0017-delegation-first-contracts.md) · [0018](./adr/0018-plugin-sdk-pin-parity.md) · [0019](./adr/0019-native-subagent-rendering.md)

Numbering follows in-repo code references; records 0004–0011 do not exist in this workspace, and the gap is kept so existing references stay stable.

## Known limits

- Host-native default agents (for example `build`) do not receive OmO contracts.
- OpenCode V2 ships no native todo API; the session list is OmO's own.
- tmux mirroring is opt-in and reports its capability (off on win32).
- Validation always uses an explicit `--server`; the plugin never connects to a managed host implicitly.
