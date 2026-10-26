# Contributing to @shtora/omo

Thank you for your interest in contributing to OmO! This document covers everything you need to know to make a meaningful contribution.

## Table of contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Code Style](#code-style)
- [Submitting Changes](#submitting-changes)
- [Architecture Decisions](#architecture-decisions)
- [Security](#security)

---

## Code of Conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/) Code of Conduct. Be respectful, inclusive, and constructive in all interactions.

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.4.2
- [OpenCode](https://opencode.ai/v2) ≥ 2.0.32 (for integration testing)
- Git

### Installation

```sh
# Clone the repository
git clone https://github.com/orgShtora-1/omo.git
cd omo/shtora/omo

# Install dependencies
bun install

# Run the full check suite
bun run check
```

### Project Structure

```
src/
├── agents/       # Agent profiles, prompts, and registration
├── boulder/      # Goal tracking and boulder store
├── config/       # Schema validation and runtime config
├── context/      # Context compaction and preservation
├── deepini/      # DeepINI routing commands
├── delegation/   # Delegation policy and skill selection
├── diagnostics/  # Blocked runs panel
├── doctor/       # Host diagnostics
├── evidence/     # Revision linking and artifact probing
├── errors/       # Error hierarchy and registry
├── execution/    # Scheduler, retries, and staleness
├── goal/         # Goal tooling
├── handoff/      # Session handoff
├── hashline/     # Hash-based edit validation
├── lsp/          # LSP query and apply tools
├── mcp/          # MCP server registration
├── memory/       # Memory persistence and reflection
├── plans/        # Plan model, transitions, and tools
├── refactor/     # Refactor command templates
├── runtime/      # Core runtime and tool guards
├── sessions/     # Session management
├── skills/       # Skill catalog and installation
├── slashcommands/# Slash command surface
├── state/        # SQLite persistence and migrations
├── teams/        # Team mailbox runtime
├── telemetry/    # Diagnostic event recording
├── terminal/     # TUI and terminal commands
├── todo/         # Todo persistence and sync
└── worktrees/    # Worktree lifecycle management

test/
├── unit/         # Unit tests (run with bun test test/unit)
├── integration/  # Integration tests (require OpenCode host)
├── evals/        # Evaluation harness
└── live/         # Live host integration tests
```

---

## Development Workflow

### Branch Strategy

- `main` — stable branch, always passing
- Feature branches — `<type>/<description>` (e.g., `feat/error-registry`)
- Bug fixes — `fix/<description>`

### Making Changes

1. **Create a branch** from `main`:
   ```sh
   git checkout -b feat/your-feature
   ```

2. **Write tests first** (TDD for policies and state machines):
   ```sh
   bun test test/unit/your-module.test.ts
   ```

3. **Implement** the change.

4. **Run the full check suite**:
   ```sh
   bun run check
   ```

5. **Commit with a descriptive message**:
   ```sh
   git commit -m "feat(delegation): add circular delegation detection"
   ```

6. **Push and open a PR**:
   ```sh
   git push origin feat/your-feature
   ```

---

## Testing

### Test Commands

```sh
# Run all unit tests
bun run test:unit

# Run integration tests (requires OpenCode host)
bun run test:integration

# Run evaluation tests
bun run test:evals

# Run live host tests
bun run test:live

# Full check (lint + build + typecheck + tests)
bun run check
```

### Writing Tests

- Use Bun's native test runner (`bun:test`)
- Name files `<module>.test.ts`
- Use descriptive test names: `it("rejects duplicate attempt IDs")` not `it("test 1")`
- Mock external dependencies (filesystem, SQLite) with inline mock objects
- Keep tests deterministic — no random values, no timestamps in assertions

### Test Categories

| Category | Location | Requirement |
|----------|----------|-------------|
| Unit | `test/unit/` | Required for all new code |
| Integration | `test/integration/` | Required for host-dependent features |
| Evals | `test/evals/` | Optional, for behavior validation |
| Live | `test/live/` | Optional, requires authenticated host |

### Windows Testing

OmO is Windows production-ready as of v0.2.0. When adding tests that interact with the filesystem or SQLite:

- Use `rmRetry` / `rmSyncRetry` from `test/unit/test-utils.ts` for directory cleanup (handles EBUSY)
- Call `store.close()` on `BoulderStore` and `GoalStore` before temp directory cleanup
- Use regex path matching for cross-platform `cwd` assertions
- Default test timeout is 5000ms; integration tests may use 30000ms

---

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting.

```sh
# Auto-format
bun run format

# Check without fixing
bun run lint
```

### Guidelines

- **TypeScript strict mode** — no `any`, explicit return types on public APIs
- **Zod v4** for all config validation
- **Error codes** — use the centralized registry in `src/errors/registry.ts`
- **Async I/O** — prefer `node:fs/promises` over sync variants
- **Immutable state** — plans and worktrees are immutable; use structural updates

---

## Submitting Changes

### Pull Request Checklist

- [ ] Tests added for all new behavior
- [ ] All existing tests pass (`bun run test:unit`)
- [ ] Build succeeds (`bun run build`)
- [ ] Type checking passes (`bun run typecheck`)
- [ ] Linting passes (`bun run lint`)
- [ ] ADR updated if architectural decision changed
- [ ] CHANGELOG entry (if applicable)

### Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(delegation): add circular delegation detection
fix(worktrees): prevent orphaned checkouts on crash
docs: update ADR 0015 with WAL mode rationale
chore: bump @opencode/plugin to 2.0.35
```

---

## Architecture Decisions

Major architectural decisions are documented as [Architecture Decision Records (ADRs)](./docs/adr/) in the `docs/adr/` directory. If your change impacts an existing ADR or introduces a new architectural decision, update or create the relevant ADR.

---

## Security

See [SECURITY.md](./SECURITY.md) for security policies and reporting procedures.

### Reporting Vulnerabilities

Do **not** open a public issue for security vulnerabilities. Instead:

1. Email `security@shtora.dev` with details
2. Do not disclose publicly until the issue is resolved
3. Include steps to reproduce and potential impact

---

## Getting Help

- Open an [issue](https://github.com/orgShtora-1/omo/issues) for bugs or feature requests
- Join the [Shtora Discord](https://discord.gg/shtora) for real-time discussion
- Read the [PRODUCT-SPEC.md](./docs/PRODUCT-SPEC.md) for the full product vision
