// The original generator and text source are absent from this checkout;
// maintain this template here until those inputs are restored.
export const REFACTOR_TEMPLATE = `# Intelligent Refactor Command

Refactor code with LSP grounding, AST-pattern evidence, an explicit codemap, a test-coverage gate, and verification after every single step.

Refactoring target: \`\${target}\`
Scope: \`\${scope}\`
Strategy: \`\${strategy}\`
Workspace root: \`\${root}\`

## Non-negotiable grounding mandate

You may not describe code you have not read, and you may not describe impact you have not measured.

- Any claim about what a symbol does requires \`omo_lsp_definition\` or a read of the file.
- Any claim about who uses a symbol requires \`omo_lsp_references\`.
- Any claim about how many places match a pattern requires the \`ast-grep\` skill, not \`grep\`.
- Any claim about test coverage requires running the tests or reading the test files.

If a tool is unavailable in this session, say so and mark the claim unmeasured. Never substitute a plausible guess for a measurement.

## Harness vocabulary

| Concept | Use this |
|---|---|
| Spawn a background explorer | \`subagent\` with \`agent: "explore"\`, \`background: true\` |
| Spawn a foreground specialist | \`subagent\` with \`agent: "explore"\` |
| Run independent work concurrently | \`omo_parallel\` |
| Plan generation | \`omo_delegate\` with \`route: { kind: "agent", id: "planner" }\` |
| Independent review | \`omo_delegate\` with \`route: { kind: "agent", id: "reviewer" }\` |
| Exit-criteria check | \`omo_delegate\` with \`route: { kind: "agent", id: "verifier" }\` |
| Architecture or root-cause reasoning | \`omo_delegate\` with \`route: { kind: "agent", id: "orchestrator" }\` |
| Library and migration research | \`omo_delegate\` with \`route: { kind: "agent", id: "researcher" }\` |
| Group work with shared tasks | \`omo_plans\` and \`omo_team\` |
| Isolated checkout for risky edits | \`omo_worktree\` |
| Definition / references / symbols | \`omo_lsp_definition\`, \`omo_lsp_references\`, \`omo_lsp_symbols\`, \`omo_lsp_workspace_symbols\` |
| Diagnostics | \`omo_lsp_diagnostics\` |
| Rename | \`omo_lsp_prepare_rename\`, \`omo_lsp_rename\`, \`omo_lsp_apply\` |
| AST search and rewrite | the \`ast-grep\` skill |
| Durable notes across sessions | \`omo_memory_save\`, \`omo_memory_recall\` |

If a name above is not present in this session, use the closest available equivalent and say which one you used. If a background subagent reports completion through a system notification, use that notification rather than polling for it.

## Phase 0: Intent gate

Run this before touching anything.

Classify the request:

- A specific file, symbol, or function is named → **explicit**. Proceed.
- A transformation is stated as "refactor X into Y" → **clear**. Proceed.
- The request is "improve", "clean up", "make it better", "tidy" → **must ask**.
- The scope is ambiguous, spanning an unclear boundary → **must ask**.
- Required context is missing → **must ask**.

Before proceeding, confirm you can name all four: the target, the outcome, the scope, and the success criteria. If any is missing, ask.

When you must ask, use this shape and stop:

**What I understood** — the target and the outcome, in one or two sentences.

**What I'm unsure about** — the specific ambiguity, not a vague hedge.

1. First option. What it means. What it costs.
2. Second option. What it means. What it costs.

**My recommendation** — one option, with the reason.

End with the question you actually need answered.

## Phase 1: Codebase analysis

Fire all five background explorers in ONE batch. Do not serialize them.

1. Target and definitions — what exactly exists at the target, its real signature, its real types.
2. Dependency chain — what the target imports, what imports it, transitively.
3. Established patterns — how this codebase already solves the problem you are about to solve.
4. Tests — what covers the target today, and what the assertions actually check.
5. Architecture — the role the target plays in the system, and the invariant it protects.

Give each one a concrete \`Report:\` contract: files with line ranges, symbol names, and a one-line verdict per item.

While they run, do your own measurement in the main session:

- \`omo_lsp_symbols\` scoped to the document, then to the workspace.
- \`omo_lsp_references\` on the target symbols, with the declaration included.
- \`omo_lsp_workspace_symbols\` to find the neighbouring vocabulary.
- \`omo_lsp_diagnostics\` for the current baseline, before any edit.
- The \`ast-grep\` skill for exports, imports, and call sites.
- A read of every file that references the target.

## Phase 2: Codemap

Produce this, and nothing vaguer:

\`\`\`
## CODEMAP: <TARGET>

### Core Files (Direct Impact)
<path>:<Lx-Ly> — <role in one line>

### Dependency Graph
<target>
  imports from: <a>, <b>
  imported by: <c>, <d>
  used by: <e> (dynamic or reflective only — verify before claiming)

### Impact Zones

| Zone | Risk Level | Files Affected | Test Coverage |
|---|---|---|---|
| Core | HIGH | | |
| Consumers | MEDIUM | | |
| Edge | LOW | | |

### Established Patterns
\`\`\`

Then classify every constraint you discovered into exactly one bucket:

- **MUST follow** — the codebase's own rule for this kind of change.
- **MUST NOT break** — the invariant, contract, or public surface that other code depends on.
- **Safe to change** — genuinely local, no measured consumers.
- **Requires migration** — changes that need a coordinated update elsewhere.

## Phase 3: Test coverage gate

Measure before deciding. Do not assume coverage.

| Measured coverage | Decision |
|---|---|
| HIGH, above 80% | Run the existing tests after every step. |
| MEDIUM, 50 to 80% | Run the tests and add safety assertions around the change. |
| LOW, below 50% | **Pause.** Propose writing the tests first. |
| NONE | **Block** aggressive refactoring. |

At LOW or NONE, stop and offer three options:

1. Write the tests first. **Recommended.**
2. Proceed cautiously, with extra manual verification at each step.
3. Abort the refactor.

Then emit the plan you will follow:

\`\`\`
## VERIFICATION PLAN

### Test Commands
<the exact commands, copy-pasteable>

### Verification Checkpoints
1. <checkpoint>
2. <checkpoint>
3. <checkpoint>

### Regression Indicators
<what a regression looks like for this specific change>
\`\`\`

## Phase 4: Plan

Delegate plan generation to \`planner\` with the codemap, the measured coverage, and the four constraint buckets. Require atomic steps where each one is independently verifiable, in dependency order, each naming exact files and line ranges, each with a rollback.

Review the returned plan against four points:

1. Does every step map to a line in the codemap?
2. Is any step larger than one verifiable unit?
3. Does the order respect the dependency chain?
4. Is there a rollback for every step that can break the build?

Then create the checklist, interleaving one \`refactor-N\` entry and one \`verify-N\` entry per step.

If the work has three or more steps that touch disjoint files, use \`omo_plans\` and \`omo_team\` to run them concurrently. Serialize anything that touches the same files. Take an isolated \`omo_worktree\` when two writers would otherwise collide. The lead never edits files directly when a team is running.

## Phase 5: Execute

Per step, four movements. The third is not optional.

**Pre-step.** Mark the step \`in_progress\`. Read the current state. Record the \`omo_lsp_diagnostics\` baseline.

**Execute.** Choose the path by the kind of change:

- Symbol rename → \`omo_lsp_prepare_rename\`, then \`omo_lsp_rename\`. Never a text search.
- Pattern transform → the \`ast-grep\` skill, preview first, then apply. Show the preview.
- Structural change → an exact edit with enough surrounding context to be unambiguous.

**Post-step verification. Mandatory, every step.**

- \`omo_lsp_diagnostics\` over every touched file.
- The test commands from the verification plan.
- The type check.

**Step completion.** Mark the step complete only when all three passed. Update the checklist in real time.

On failure: **stop, revert, diagnose, then choose.** Never continue to the next step with failing tests. Never delete or weaken a test to make the suite pass. Never silence an error with \`any\`, a suppression comment, or an unchecked cast.

Commit at logical checkpoints, one commit per coherent step.

## Phase 6: Final verification

Run, and report only what you observed:

- The full test suite.
- The type check.
- The lint.
- The build.
- \`omo_lsp_diagnostics\` across every file you touched.

Then produce:

\`\`\`
### What Changed
### Files Modified
### Verification Results
- Tests: PASSED (X/Y passing)
- Type Check: CLEAN
- Lint: CLEAN
- Build: SUCCESS
### No Regressions Detected
\`\`\`

If any line of that block is not true, say which one and why. Do not ship a clean summary over a red run.

## Never

- Skip diagnostics after a change.
- Proceed with failing tests.
- Change code without having measured the impact.
- Silence a type error.
- Delete a test to make the suite green.
- Commit broken code.
- Refactor without understanding the established pattern.

## Always

- Understand before changing.
- Preview a structural rewrite before applying it.
- Verify after every change.
- Follow the pattern the codebase already uses.
- Keep the checklist current in real time.
- Report a problem the moment you hit it.

## Abort immediately when

- The target has zero test coverage and you are about to refactor aggressively.
- The change would break a public API.
- The scope is still unclear after asking.
- Three consecutive verification failures.
- A user constraint would have to be violated.

## On deprecated code

Before rewriting something deprecated, delegate to \`researcher\` for the current recommended replacement and record the finding. Do not silently upgrade a dependency to its latest version. If a migration is genuinely wanted, fetch the current documentation for the target version first.

Refactoring without tests is reckless. Refactoring without understanding is destructive. This command exists so you do neither.`.trim()
