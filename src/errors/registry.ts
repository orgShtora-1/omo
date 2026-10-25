/**
 * Centralized error code registry for @shtora/omo.
 *
 * All error codes are declared here in one place. This prevents:
 *  - Typos that silently create new string literals instead of known codes
 *  - Duplicate codes across modules
 *  - Undocumented codes that appear in production
 *
 * To add a new code:
 *  1. Append to the appropriate category in `ERROR_CODES`.
 *  2. Update the `ErrorCode` union below.
 *  3. Add a corresponding test in `test/unit/error-registry.test.ts`.
 */

// ─── Worktree codes ───────────────────────────────────────────────────────────
export const WORKTREE_CODES = {
  cancelled: "cancelled",
  "git-failed": "git-failed",
  "git-unavailable": "git-unavailable",
  "dirty-worktree": "dirty-worktree",
  "not-owned": "not-owned",
  "ownership-mismatch": "ownership-mismatch",
  "recovery-required": "recovery-required",
  "repository-required": "repository-required",
  "task-reserved": "task-reserved",
  "integration-busy": "integration-busy",
  "review-stale": "review-stale",
  "target-stale": "target-stale",
  "dirty-target": "dirty-target",
  "merge-in-progress": "merge-in-progress",
  "integration-uncertain": "integration-uncertain",
  "resource-cleaned": "resource-cleaned",
  "operation-active": "operation-active",
  "invalid-input": "invalid-input",
  "future-version": "future-version",
  "corrupt-state": "corrupt-state",
  "unintegrated-work": "unintegrated-work",
} as const

// ─── Plan codes ────────────────────────────────────────────────────────────────
export const PLAN_CODES = {
  "duplicate-step": "duplicate-step",
  "dependency-cycle": "dependency-cycle",
  "missing-dependency": "missing-dependency",
  "illegal-transition": "illegal-transition",
  "unknown-step": "unknown-step",
  "dependencies-incomplete": "dependencies-incomplete",
  "foreign-parent": "foreign-parent",
  "duplicate-attempt": "duplicate-attempt",
  "stale-attempt": "stale-attempt",
  "invalid-evidence": "invalid-evidence",
  "duplicate-evidence": "duplicate-evidence",
  "verification-required": "verification-required",
  "reason-required": "reason-required",
  "parent-cancelled": "parent-cancelled",
} as const

// ─── Subprocess codes ─────────────────────────────────────────────────────────
export const PROCESS_CODES = {
  timeout: "timeout",
  spawn: "spawn",
  cancelled: "cancelled",
  "runtime-detach": "runtime-detach",
} as const

// ─── Delegation codes ─────────────────────────────────────────────────────────
export const DELEGATION_CODES = {
  "unknown-category": "unknown-category",
  "unknown-agent": "unknown-agent",
  "primary-agent": "primary-agent",
  "invalid-model": "invalid-model",
  "disallowed-model": "disallowed-model",
  "circular-delegation": "circular-delegation",
  "skill-requirement-unmet": "skill-requirement-unmet",
  "handoff-too-large": "handoff-too-large",
} as const

// ─── Skill codes ──────────────────────────────────────────────────────────────
export const SKILL_CODES = {
  "install-failed": "install-failed",
  "audit-fail": "audit-fail",
  "audit-warn": "audit-warn",
  "unknown-skill": "unknown-skill",
  "permission-denied": "permission-denied",
  "catalog-read-failed": "catalog-read-failed",
  "hashline-mismatch": "hashline-mismatch",
} as const

// ─── State codes ───────────────────────────────────────────────────────────────
export const STATE_CODES = {
  "sql-error": "sql-error",
  "migration-failed": "migration-failed",
  "schema-mismatch": "schema-mismatch",
  "future-version": "future-version",
  "corrupt-state": "corrupt-state",
  "revision-conflict": "revision-conflict",
  "scope-mismatch": "scope-mismatch",
  "unsupported-version": "unsupported-version",
} as const

// ─── Agent codes ───────────────────────────────────────────────────────────────
export const AGENT_CODES = {
  "agent-not-found": "agent-not-found",
  "model-not-available": "model-not-available",
  "permission-denied": "permission-denied",
  "delegation-banned": "delegation-banned",
  "agent-collision": "agent-collision",
  "depth-exceeded": "depth-exceeded",
  "invalid-options": "invalid-options",
} as const

// ─── MCP codes ─────────────────────────────────────────────────────────────────
export const MCP_CODES = {
  "server-unavailable": "server-unavailable",
  "registration-failed": "registration-failed",
  "invalid-preset": "invalid-preset",
  capability: "capability",
} as const

export const LSP_CODES = {
  cancelled: "cancelled",
  configuration: "configuration",
  crash: "crash",
  disposed: "disposed",
  protocol: "protocol",
  timeout: "timeout",
} as const

export const BACKUP_CODES = {
  "backup-corrupt": "backup-corrupt",
  "not-a-backup": "not-a-backup",
} as const

export const TEAM_CODES = {
  "team-not-found": "team-not-found",
  "member-inactive": "member-inactive",
  "leader-required": "leader-required",
  "task-not-found": "task-not-found",
  "team-exists": "team-exists",
  "task-exists": "task-exists",
  "task-locked": "task-locked",
  "already-claimed": "already-claimed",
  "dependency-blocked": "dependency-blocked",
  "leader-removal": "leader-removal",
  "claim-mismatch": "claim-mismatch",
  "evidence-required": "evidence-required",
  "completion-conflict": "completion-conflict",
  "claim-blocked": "claim-blocked",
  "reconciliation-required": "reconciliation-required",
  "dedup-conflict": "dedup-conflict",
  "message-not-found": "message-not-found",
  "no-shutdown-request": "no-shutdown-request",
  "already-participates": "already-participates",
  "team-required": "team-required",
  "unknown-team": "unknown-team",
  "lead-only": "lead-only",
  "lead-or-member": "lead-or-member",
  "not-a-participant": "not-a-participant",
} as const

export const EXECUTION_CODES = {
  "depth-exceeded": "depth-exceeded",
  "foreign-session": "foreign-session",
  "host-error": "host-error",
  "unknown-session": "unknown-session",
} as const

// ─── Telemetry codes ──────────────────────────────────────────────────────────
export const TELEMETRY_CODES = {
  "event-truncated": "event-truncated",
  "storage-full": "storage-full",
  "redaction-failed": "redaction-failed",
} as const

// ─── Aggregate union ──────────────────────────────────────────────────────────
export const ERROR_CODES = {
  ...WORKTREE_CODES,
  ...PLAN_CODES,
  ...PROCESS_CODES,
  ...DELEGATION_CODES,
  ...SKILL_CODES,
  ...STATE_CODES,
  ...AGENT_CODES,
  ...MCP_CODES,
  ...TELEMETRY_CODES,
  ...LSP_CODES,
  ...BACKUP_CODES,
  ...TEAM_CODES,
  ...EXECUTION_CODES,
} as const

/** All valid error codes as a single union type. */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** Check whether a string is a recognized error code. */
export function isErrorCode(code: string): code is ErrorCode {
  return Object.values(ERROR_CODES).includes(code as ErrorCode)
}

/**
 * Return the category name for an error code, or `undefined` if unknown.
 * Categories match the submodule that owns the code.
 */
export function errorCodeCategory(code: ErrorCode): string | undefined {
  for (const [category, codes] of Object.entries({
    worktree: WORKTREE_CODES,
    plan: PLAN_CODES,
    process: PROCESS_CODES,
    delegation: DELEGATION_CODES,
    skill: SKILL_CODES,
    state: STATE_CODES,
    agent: AGENT_CODES,
    mcp: MCP_CODES,
    telemetry: TELEMETRY_CODES,
    lsp: LSP_CODES,
    backup: BACKUP_CODES,
    team: TEAM_CODES,
    execution: EXECUTION_CODES,
  }) as Array<[string, Record<string, ErrorCode>]>) {
    if (Object.values(codes).includes(code)) return category
  }
  return undefined
}
