# Contributing to @shtora/omo

Thanks for your interest in contributing! This document covers the minimum you need to build, verify and ship changes.

## Development setup

Requirements: [Bun](https://bun.sh) >= 1.4.2 and an [OpenCode](https://opencode.ai/v2) V2 host for live checks.

```sh
bun install
```

## Verification

Every change must pass the project gate before review:

```sh
bun run check
```

This runs Biome lint, the build, TypeScript typecheck, and the unit + integration test suites. Scope-specific extras:

| Command | Purpose |
| --- | --- |
| `bun run test:package` | Installs the built tarball in an isolated project and resolves both exports |
| `bun run test:host-package` / `test:host-lifecycle` / `test:host-rollback` | Live host registration, restart and rollback smokes (opt-in, need an explicit `--server`) |
| `bun run test:skills-capability` | End-to-end validation of the pinned Skills MCP catalog in a sandbox |
| `bun run format` | Apply Biome formatting |

## Pull requests

1. Keep PRs focused: one behavior change or fix per PR.
2. Preserve the fail-closed posture: prefer errors that stop startup with an actionable message over silent fallbacks.
3. Update `README.md` when behavior, configuration or tools change.
4. Add or update tests alongside the change — the `check` gate enforces this indirectly.
5. Architectural decisions get an ADR under `docs/adr/` (see existing entries for format).

## Reporting bugs

Open a [bug report](https://github.com/orgShtora-1/omo/issues/new?template=bug_report.yml) with versions and reproduction steps. For questions, use [Discussions](https://github.com/orgShtora-1/omo/discussions).

## Licensing

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
