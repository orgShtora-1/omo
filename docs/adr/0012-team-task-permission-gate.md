# ADR 0012: Team task permission gate

- Status: Accepted (retroactive record; the decision predates this document)
- Date: 2026-10-18

## Context

OpenCode V2's canonical delegation action is `subagent`: project permission rules that want to stop re-delegation typically express it as `subagent * deny`. `omo_team`, however, is also the coordination surface for non-nesting children — team members read the mailbox, claim tasks and acknowledge messages. If the tool carried the canonical `subagent` permission, a rule intended to block re-delegation would also hide team coordination from children that never delegate at all.

The code carries this decision as a comment in `src/teams/tools.ts` (`omo_team` registration) and defers to `authorizeParent` for the actual delegation gate.

## Decision

- `omo_team` keeps the legacy permission key **`task`** instead of `subagent`, so `subagent * deny` rules do not hide mailbox and claim actions from non-nesting children.
- Actual delegation remains gated separately: `authorizeParent` treats `task` permission rules as subagent-delegation rules, fail-closed; `ask` is never auto-granted.
- Broad denies (`*`) and explicit `task` denies still apply to the team tool.

## Consequences

A project can block re-delegation without cutting off team coordination. Projects that want both hidden must deny `task` explicitly. Renaming the permission to the canonical action remains deferred to a future configuration revision, because it would change the meaning of existing user permission rules.
