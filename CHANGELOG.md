# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-25

### Fixed

- **P1-4**: `thinkMode` propagation to `ResolvedProfile` for CLI `--think` flag support
- **P1-3**: `consult` permission evaluation now supported alongside `subagent`/`task`
- **P1-2**: Evidence gate hardened with SHA-256 hash verification for step artifacts
- **P1-1**: Auto-install skill confirmation flow added with `confirm` callback
- **P2-1**: Journal `RunRecord` now captures failure `reason` for post-mortem
- **P2-2**: Live test `PRODUCT` path resolved via `import.meta.dirname` (Windows compatible)

### Changed

- Windows file locking resolved: SQLite stores (`BoulderStore`, `GoalStore`) now expose `close()` for deterministic cleanup
- Retry utilities (`rmRetry`, `rmSyncRetry`) handle EBUSY on Windows temp directories with 10 retries / 500ms delay
- Subprocess `cwd` path matching made cross-platform with regex
- Test fixtures updated for proper `AbortSignal` handling in event subscriptions
- Journal index performance test threshold relaxed (500 records, 100ms, 30s timeout)

### Added

- `test/unit/test-utils.ts` with Windows-safe `rmRetry`/`rmSyncRetry` utilities
- Optional `store` parameter to `mountGoal` and `createGoalCommandService` to avoid duplicate DB connections

### Security

- Skill auto-install requires explicit confirmation (mitigation: `autoInstall: false` in config)
- Evidence artifacts verified by hash before step completion (mitigation: `verifyArtifacts: true`)
- Strict audit mode available (mitigation: `strictAudits: true`)

## [0.1.0] - 2026-10-22

### Added

- First stable release of `@shtora/omo`: OpenCode V2 plugin for agent orchestration.
- Durable plans with evidence-gated steps (`omo_plan`, `omo_status`, `omo_blocked`, `omo_revision`).
- Parallel delegation with bounded admission to 17 routed agent profiles (`omo_delegate`, `omo_parallel`, `omo_consult`).
- Session todos joined with live plan progress (`omo_todo_read`, `omo_todo_write`, `/handoff`).
- Memory with dream/time reflection (`omo_memory_*`), LSP intelligence with reviewed edits (`omo_lsp_*`, `omo_lsp_apply`), optional TUI face.
- Built-in MCP presets: github, context7, skills (vercel/cloudflare opt-in).
- Built-in skill manager tools, commands (`/omo-*`, `/refactor`, `/deep-ini`) and host worktree integration.

### Migration notes

- `@hallaxius/omo-beta` is superseded by `@shtora/omo`. Replace the host `plugins` entry and reload. Tool names, commands, agent IDs and the configuration schema are unchanged; plans, teams and memory written under the `hallaxius.omo` state scope are not picked up automatically. The beta package receives no further releases.

[0.1.0]: https://github.com/orgShtora-1/omo/releases/tag/v0.1.0
