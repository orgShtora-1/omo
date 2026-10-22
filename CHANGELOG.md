# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
