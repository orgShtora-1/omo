# @shtora/omo

[![npm version](https://img.shields.io/npm/v/@shtora/omo)](https://www.npmjs.com/package/@shtora/omo)
[![license](https://img.shields.io/npm/l/@shtora/omo)](./LICENSE)
[![runtime](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.4.2-fdd50b)](https://bun.sh)

Maintained by Shtora.

`@shtora/omo` is a native [OpenCode V2](https://opencode.ai/v2) plugin that turns the host into an orchestrated agent runtime: durable plans with evidence-gated steps, bounded parallel delegation to routed specialists, session todos joined with live plan progress, handoff artifacts, memory with dream/time reflection, LSP intelligence with reviewed edits, and an optional TUI face.

## Table of contents

- [Compatibility](#compatibility)
- [Installation](#installation)
- [Configuration](#configuration)
- [MCP servers](#mcp-servers)
- [What you get](#what-you-get)
- [Session todos](#session-todos)
- [State and backup](#state-and-backup)
- [Honest limits](#honest-limits)
- [Release validation and publishing](#release-validation-and-publishing)
- [License](#license)

## Compatibility

| Requirement | Value |
| --- | --- |
| Host | OpenCode V2 (validated live against host CLI 2.0.32) |
| Plugin SDK | `@opencode/plugin` 2.0.32 (the only runtime dependency, exact pin at host parity) |
| Runtime | Bun >= 1.4.2, ESM-only |
| Platforms | Windows verified live; tmux integrations are opt-in and report capability on win32 |

The package exposes two faces, both resolved the way the V2 host expects: the server face at the package root (plus the root `server.ts` directory entrypoint) and the TUI face at the `./tui` export (plus the root `tui.ts`). The TUI uses native dialogs and a type-checked SDK definition, with no bundled Solid runtime. Server features work without the TUI.

## Installation

Register the plugin with the OpenCode host in `opencode.jsonc` — project scope (`.opencode/opencode.jsonc`) or user scope (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "@shtora/omo" }]
}
```

Or register it through the host CLI, which writes the same entry for you:

```sh
opencode plugin add @shtora/omo
```

Plugin options ride on the same entry when you need them (see [Configuration](#configuration)):

```jsonc
{
  "plugins": [
    {
      "package": "@shtora/omo",
      "options": { "schemaVersion": 1 }
    }
  ]
}
```

## Configuration

OmO reads a shared `omo.jsonc` beside OpenCode's user configuration: `$XDG_CONFIG_HOME/opencode/omo.jsonc`, or `~/.config/opencode/omo.jsonc` when XDG is unset. `OMO_CONFIG_HOME` overrides that directory. When neither this file nor the legacy `~/.omo/omo.jsonc` exists, OmO creates a minimal default configuration. The legacy file remains a read-only fallback until the new primary exists.

For project-specific settings, use the `options` object on the host's plugin entry; these options override the shared file. Omitted keys fall back to defaults; corrupt or future-version config is preserved on disk and reported, never overwritten (fail closed). The full annotated example ships in [`examples/omo.jsonc`](./examples/omo.jsonc):

```jsonc
{
  "schemaVersion": 1,
  "agents": {
    // Per-agent model overrides, e.g. "sisyphus": "provider/model#variant".
    // Omitted agents inherit the host model.
  },
  "execution": {
    "maxChildren": 3,          // concurrent children per project
    "admissionTimeoutMs": 120000,  // queued delegations fail fast instead of pending
    "staleTimeoutMs": 900000,      // a child with no host progress is reaped
    "timeoutMs": 1200000,
    "foregroundTimeoutMs": 600000,
    "backgroundTimeoutMs": 3600000,
    "providerLimits": {},
    "modelLimits": {},
    "verifyArtifacts": false,   // opt-in artifact checks (existence + root confinement)
    "maxRetries": 2,            // bounded attempts: 1 try + 2 retries
    "maxAttempts": 3,
    "fallback": false
  },
  "skills": {
    "auto": true,
    "recommendedLimit": 5,
    "required": [],
    "autoInstall": true,        // installs a missing skill from skills.sh into the project
    "requireAuditPass": true,  // refuses skills whose audit reports fail
    "strictAudits": false      // with the guard on, also refuses warn/unknown audit verdicts
  },
  "mcp": {
    "enabled": true,            // contribute OmO's built-in MCP presets automatically
    "servers": {
      "github": { "disabled": false },
      "context7": { "disabled": false },
      "skills": { "disabled": false },
      // Optional presets stay disabled unless explicitly enabled:
      "vercel": { "disabled": true },
      "cloudflare": { "disabled": true }
    }
  },
  "runtime": {
    "packageManager": "bun"    // bun | npm | yarn | pnpm; drives npx/bunx/dlx runner choice
  },
  "memory_dream": {
    "enabled": true,
    "idleMinutes": 30,         // dream/time reflection fires only after this idle gap
    "minHoursBetween": 24
  }
}
```

Agent profiles and delegation categories are configured in the same [`examples/omo.jsonc`](./examples/omo.jsonc). For a project-specific override, use these fields in the plugin entry's `options` object:

```json
{
  "schemaVersion": 1,
  "profiles": [{ "id": "planner", "mode": "subagent", "allowWrite": false }],
  "categories": [{ "id": "investigate", "agent": "planner" }]
}
```

## MCP servers

OmO registers its built-in MCP presets through OpenCode's plugin MCP lifecycle during startup; the host needs only the `plugins` entry shown in [`examples/opencode.jsonc`](./examples/opencode.jsonc). OmO never writes host MCP configuration, and a server already present under `mcp.servers` with the same name remains authoritative (including `disabled: true`).

Default presets:

- **github** — remote `https://api.githubcopilot.com/mcp/`; uses `GITHUB_API_KEY` as a Bearer token on this canonical endpoint when present, otherwise registration stays host-authenticated
- **context7** — remote `https://mcp.context7.com/mcp`; uses `Authorization: Bearer ${CONTEXT7_API_KEY}` on this canonical endpoint when present
- **skills** — local `@shtora/skills@0.1.0` (exact reviewed pin) launched by `runtime.packageManager` (`bunx`, `npx -y`, `yarn dlx`, or `pnpm dlx`), with `SKILLS_ALLOW_MUTATIONS=false` and `SKILLS_PROJECT_ROOT` pointing at the OpenCode location directory by default
- **vercel / cloudflare** — registered only when explicitly enabled in `omo.jsonc`

Configure only adjustments in `omo.jsonc`; omitted servers keep these defaults:

```jsonc
{
  "schemaVersion": 1,
  "mcp": {
    "enabled": true,
    "servers": {
      "github": { "disabled": true },
      "skills": { "command": ["pnpm", "dlx", "@shtora/skills@0.1.0"] },
      "vercel": { "disabled": false }
    }
  }
}
```

Secrets can use `{env:NAME}` references, resolved from the host process environment first, then from `.env` beside the active `omo.jsonc`. A missing or empty referenced variable disables only that server and `omo_doctor` reports the variable name, not its value. Replacing a remote `url` also replaces inherited authentication for safety; repeat the intended `headers` or `oauth` settings for the replacement endpoint. Registration is not authentication: inspect `omo_doctor` or `opencode mcp list`, and use `/mcps` in OpenCode when a remote server needs sign-in.

### Skills MCP token from `.env`

Some `@shtora/skills` actions, including semantic search and fetching skill files, require `VERCEL_OIDC_TOKEN`. To pass it to the local Skills MCP, merge this into `omo.jsonc`:

```jsonc
{
  "schemaVersion": 1,
  "mcp": {
    "servers": {
      "skills": {
        "environment": {
          "VERCEL_OIDC_TOKEN": "{env:VERCEL_OIDC_TOKEN}"
        }
      }
    }
  }
}
```

Create `.env` in that same directory (normally `~/.config/opencode`, not the project directory):

```dotenv
VERCEL_OIDC_TOKEN=your_vercel_oidc_token
```

Keep `.env` private and out of version control. OmO does not change `process.env`, copy the entire file into MCP processes, or persist resolved secrets in configuration. The explicit `environment` mapping above is required; without it, the default Skills preset remains usable for public actions without a token. An existing host `mcp.servers.skills` entry still wins and must be configured separately.

The file supports dotenv quoting, comments, multiline values and an optional `export` prefix, without shell execution or variable expansion. An existing process variable wins even when empty. An absent `.env` is allowed; other read errors fail plugin startup without exposing file contents. When using the legacy `~/.omo/omo.jsonc` fallback, its adjacent `.env` is used instead.

Restart OpenCode or reload the project after editing `.env`; an MCP-only reconnect/reload reuses the startup snapshot. Token renewal is external to OmO: replace expired tokens and restart/reload again.

### Skills 1.1 local management tools

The pinned Skills MCP additionally exposes local skill management tools: `skills_list_installed_skills`, `skills_check_skill_updates`, `skills_install_skill`, `skills_update_skill`, and `skills_remove_skill`. OmO enables them read-only by default:

- `SKILLS_ALLOW_MUTATIONS` defaults to `"false"`, so install/update/remove refuse with `PERMISSION_DENIED` until you opt in. Per-key `environment` entries in `omo.jsonc` still win over these defaults.
- `SKILLS_PROJECT_ROOT` points at the OpenCode location directory, so project-scope inventory and updates read the real project, never the host working directory.
- `GITHUB_TOKEN`/`GH_TOKEN` are never forwarded implicitly; map them under `mcp.servers.skills.environment` only if you need higher GitHub API rate limits.

Opting in only lifts OmO's default refusal; every upstream write still requires its own preview plus `confirm`/`confirmation_token` flow, which proves freshness, not human consent:

```jsonc
{
  "schemaVersion": 1,
  "mcp": {
    "servers": {
      "skills": {
        "environment": { "SKILLS_ALLOW_MUTATIONS": "true" }
      }
    }
  }
}
```

As defense in depth, deny the mutating tools in the host `opencode.jsonc` (OpenCode applies the last matching rule; unmatched tools ask):

```jsonc
{
  "permissions": [
    { "action": "skills_install_skill", "resource": "*", "effect": "deny" },
    { "action": "skills_update_skill", "resource": "*", "effect": "deny" },
    { "action": "skills_remove_skill", "resource": "*", "effect": "deny" }
  ]
}
```

`omo_doctor` reports a `mcp-skills-capability` check built from the live tool catalog, never from version metadata or secret values. It fails when only the legacy discovery-only catalog is connected — usually a stale package-runner cache or a host that needs a restart — and skips while the server is absent, disabled, or not connected.

Auto-installed skills respect `skills.strictAudits` (default `false`): together with the default audit guard (`skills.requireAuditPass`, line 89 above), setting it to `true` means only a `pass` audit verdict may auto-install, while `warn` and `unknown` are refused like `fail`. Validate the pinned package end to end with `bun run test:skills-capability`, which installs `@shtora/skills@0.1.0` in an isolated sandbox and exercises the ten-tool catalog, read-only inventory, mutation refusals, and preview isolation against a temporary project.

## What you get

### Tools (namespace `omo`, permission in parentheses)

| Tool | What it does |
| --- | --- |
| `omo_plan` (edit) | Durable plans: create (steps with `id`, `objective`, `dependencies`), cancel, resume, verify |
| `omo_status` (read) | Persisted plans, attempts and recovery blockers |
| `omo_blocked` (read) | Every blocked run and step, with the recorded reason verbatim |
| `omo_revision` (read) | Whether stored evidence still agrees with the code revision it claims |
| `omo_doctor` (read) | Compatibility diagnosis of host, SDK and required capabilities |
| `omo_session` (read) | Curated identity/context over the caller's ancestor chain |
| `omo_boulder_state` (read) | Persisted work in flight, plan checklist, pending handoff invitations |
| `omo_boulder_update` (edit) | Start/advance tracked work |
| `omo_create_goal` / `omo_update_goal` / `omo_get_goal` | Goal lifecycle for the current project and session |
| `omo_team` (edit) | Durable team tasks and mailbox; claims survive host restarts |
| `omo_worktree` (edit) | Prepare, inspect, recover, integrate and clean up owned isolated checkouts |
| `omo_delegate` (edit) | One bounded assignment routed to an agent or category |
| `omo_parallel` (edit) | Up to 3 concurrent assignments with disjoint file ownership |
| `omo_consult` (read) | Read-only consultation through `explore` or `librarian` |
| `omo_command` (shell) | Runs a command under the native shell permission |
| `omo_hashline_edit` (edit) | Edits anchored to content hashlines so stale files fail closed |
| `omo_lsp_<server>_<operation>` (read) | LSP queries per configured server; renames return a reviewable `WorkspaceEdit` proposal (`applied=false`) |
| `omo_lsp_apply` (edit) | Applies a reviewed proposal under the native edit permission, SHA-256 per file |
| `omo_memory_save` / `omo_memory_recall` / `omo_memory_reflect` / `omo_memory_reflection_state` / `omo_memory_pipeline` (edit) | Bounded memory queue; the dream/time trigger fires only after the configured idle gap and cadence |
| `omo_memory_commit` (edit) | Commits memories to git — one commit, limited to memory files |
| `omo_monitor` / `omo_look_at` (read) | Opt-in tmux status mirror, fail-closed when unavailable |
| `omo_compact` (edit) | Native compaction plus durable-state reconciliation |
| `omo_todo_read` (read) | This session's todos and plan-step statuses |
| `omo_todo_write` (edit) | Replaces the manual session list (up to 100 items; `[]` clears it) |

Plan steps only count as completed when their evidence verifies — model success alone is not enough.

### Commands

| Command | What it does |
| --- | --- |
| `/omo-plan`, `/omo-status`, `/omo-resume`, `/omo-cancel`, `/omo-compact`, `/omo-doctor` | Straight into the project runtime; arguments pass through |
| `/handoff` | Continuation artifact for a new session or a bounded child assignment (`--to=session\|agent`), carrying the live todo state |
| `/refactor` | Gated refactor: intent check, LSP codemap, coverage gate (`--scope=file\|module\|project`, `--strategy=safe\|aggressive`) |
| `/deep-ini` | Deep hierarchical `AGENTS.md` knowledge base (`--create-new`, `--update`, `--dry-run`, `--max-depth=N`, `--root=PATH`) |
| `/omo-tasks` (TUI) | Plan dialog — status, resume, cancel — plus the family session picker |

### Agents and routing

The plugin registers 17 distinct profiles:

- **Primary:** `sisyphus`, `hephaestus`, `prometheus`, `atlas`.
- **Subagents:** `orchestrator`, `planner`, `executor`, `explore`, `researcher`, `reviewer`, `verifier`, `oracle`, `librarian`, `multimodal-looker`, `metis`, `momus`, `sisyphus-junior`.

Default category routes are `investigate` → `explore`, `implement` → `executor`, `review` → `reviewer`, `document` → `executor`, `validate` → `verifier`. Explicit category configuration overrides these defaults; unknown categories fail closed. `planner` is read-only by default.

Primary contracts are delegation-first: bounded independent work is routed to a specialist by default, consultations are preferred over fetching or searching directly, and every delegation carries a concrete question, an owned scope and an observable exit criterion. Background delegations return on admission; results arrive as completion notifications, so a parent ends its turn instead of polling.

There is one `explore`: the improved repository investigator traces entrypoints, callers, dependencies, data flow and tests, reports absolute paths and evidence, and never edits, runs shell commands or delegates. It replaces the previous separate explorer profiles. The standard host `explore` is augmented while preserving its existing permissions and is restored on plugin unload; a custom user-defined `explore` causes a collision instead of being overwritten.

**Agent-ID migration:** replace `omo-orchestrator`, `omo-planner`, `omo-executor`, `omo-explore`, `omo-researcher`, `omo-reviewer` and `omo-verifier` with the corresponding IDs above. Update direct routes, host agent configuration/permission resources and OmO's `agents`, `profiles`, `categories` and `model_fallback` keys before reload. OmO creates no legacy aliases and does not rewrite user configuration or historical run/session records. If an old ID remains explicitly configured as a custom profile, it is still user-owned configuration, not a built-in alias. Tool names, commands, package name and plugin IDs are unchanged.

Generation options, including temperature, are inherited from the host/model configuration. OmO does not inject per-agent sampling overrides or replace explicit host choices. If a provider rejects an option configured in the host, correct that host configuration.

## Session todos

OpenCode V2 ships no native `todowrite` surface, so OmO maintains the session list itself: `omo_todo_write` replaces the manual list, and `omo_todo_read` (and `/handoff`) show it joined with a live derived view of the current plan steps — `running`/`verifying` steps appear as `in_progress`, completed only when their evidence verifies. Plan-derived entries are read-only and use the reserved `omo.plan:` id prefix, so the model cannot spoof plan progress.

## State and backup

Durable state (plans, run journal, single-owner runtime lock) lives under the `~/.omo` home (`OMO_HOME` can override it), isolated under `projects/` by project identity. Session todos live in the host's plugin KV, scoped to project + directory + session, and are **not** covered by filesystem backups of the OmO home; back up that home with your usual file-level tooling.

## Honest limits

- **No native todo API in V2.** The session list is OmO's own; it will not appear in host UIs that expect a native list. Revisit this integration when the host exposes a public native todo API.
- **KV todos are not in filesystem backups.** They are scoped to project + directory + session inside the host plugin storage; the `~/.omo` runbook does not cover them.
- **Concurrency is bounded.** At most 3 children per project, 3 attempts per assignment, and consultations are strictly read-only — by design, not by accident. Queued delegations fail fast with an actionable error once the admission budget expires, and children that stop making host progress are reaped instead of holding a slot forever.
- **The TUI is optional.** It requires the host TUI; every server-side feature works without it.
- **Native subagent tool headers belong to OpenCode.** The inspected V2 CLI versions `2.0.27`–`2.0.32` render `<agent ID> Subagent — description`; the installed SDK has no scoped hook to reorder that heading or color only the name. OmO leaves it unchanged. The source workspace records the accepted limitation in `docs/adr/0019-native-subagent-rendering.md`.
- **tmux mirroring is opt-in** and reports its capability (off on win32) rather than silently degrading.
- **Validation always uses an explicit `--server`.** The plugin never connects to a managed host implicitly.

## Release validation and publishing

The current official release is `0.1.0`, published as `@shtora/omo` on the `latest` dist-tag. Install with `@shtora/omo`, or pin `@shtora/omo@0.1.0` for a reproducible configuration.

**Migrating from the beta package:** `@hallaxius/omo-beta` (dist-tag `beta`, last release `0.1.0-beta.3`) is superseded. Replace the host `plugins` entry `@hallaxius/omo-beta@beta` with `@shtora/omo` and reload the host; tool names, commands, agent IDs and configuration schema are unchanged, but the `shtora.omo` state scope is new, so plans, teams and memory written under `hallaxius.omo` are not picked up automatically. The beta package receives no further releases.

From the package root, run:

```sh
bun run check
bun run test:package
bun run test:mcp-host-package
bun run test:host-package
bun run test:host-lifecycle
bun run test:host-rollback
bun publish --dry-run
```

The package smoke installs the actual tarball in an isolated project and resolves both public exports; the host smokes exercise registration, restart and rollback without provider calls; the dry-run reviews the tarball without publishing. `bun publish` re-runs the same lifecycle gates through `prepublishOnly` before anything reaches the registry.

Publishing is a separate action. To publish the reviewed release artifact:

```sh
bun publish
```

`bun publish` applies `publishConfig` (`access: public`, `tag: latest`) and uses the registry credentials in `~/.npmrc`. After publication, confirm the release with `npm view @shtora/omo version`.

## License

MIT © Shtora. See [LICENSE](./LICENSE).
