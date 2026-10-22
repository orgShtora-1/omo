// The original generator and text source are absent from this checkout;
// maintain this template here until those inputs are restored.
export const HANDOFF_TEMPLATE = `# Handoff Command

Produce a handoff that another context can act on without reconstructing your memory.

Session being handed off: \`\${sessionID}\`
Selected mode: \`\${to}\`
Workspace root: \`\${root}\`

Two modes. Pick one from the flag, default \`session\`.

- \`--to=session\` — a self-contained block a person pastes into a fresh OpenCode session.
- \`--to=agent\` — a bounded assignment handed to a child agent through the plugin's delegation path.

## Non-negotiable grounding mandate

- Your memory of this session is not evidence. Long sessions and post-compact sessions truncate or summarize early messages. In-context recall is unreliable by construction.
- Never paraphrase or tidy the user's own wording. Quote it as-is or say you cannot quote it.
- Never invent a constraint the user did not state.
- If a source you needed was unavailable, say so explicitly in the output. An honest gap beats a confident fabrication.

## Mode: session

### Step 1 — Read the record before anything else

Call \`omo_session\` with \`action: "context"\` before gathering anything else. It walks your ancestor chain and is the closest authoritative source available to you about where this session came from.

Four rules:

1. Do not reconstruct the original request from memory.
2. Do not paraphrase or "tidy up" the user's wording.
3. Do not skip this step even if you feel you remember.
4. If the read fails or returns no user messages, state that plainly rather than guessing.

\`omo_session\` exposes the ancestor chain, not the full raw message history. Where you need the verbatim original request and the chain does not carry it, say so and mark that entry as unrecovered.

### Step 2 — Gather programmatic context

- \`omo_session\` with \`action: "info"\` for session identity.
- \`git diff --stat HEAD~10..HEAD\` for the recent change surface.
- \`git status --porcelain\` for uncommitted work in flight.

Do not re-derive the user's requests from these. They describe the work, not the ask.

### Step 3 — Extract

Write in the first person: "I did…", "I told you…".

Describe capabilities and behavior, not a file-by-file narration. Name variables, storage keys, and constants only when they are load-bearing for the next step.

Seven questions:

1. What did the user actually ask for, in their own words?
2. What did I complete, and what proves it?
3. What is half-done right now?
4. Which decisions did I make, and why?
5. Which files matter, and in what priority order?
6. Which constraints are explicit and non-negotiable?
7. What would the next agent get wrong if it did not know this?

### Step 4 — Format

Emit this block, in this order, exactly as shown. Plain text with dash bullets. No markdown headers inside the content. No bold, no italics, no code fences. Workspace-relative paths.

\`\`\`
════════════════════════════════════════
        HANDOFF CONTEXT
════════════════════════════════════════

USER REQUESTS (AS-IS)
- <verbatim user wording, or "UNRECOVERED - the session record did not carry it">

GOAL
<one sentence>

WORK COMPLETED
- <what I did, first person, with file paths and the key implementation decision in each>

CURRENT STATE
- Build: <observed status>
- Tests: <observed status>
- Environment and config: <what is non-default and matters>

PENDING TASKS
- <what is not done, including the live todo state>

KEY FILES
- <path> — <why it matters>          (ten maximum, highest value first)

IMPORTANT DECISIONS
- <decision> — <why>

EXPLICIT CONSTRAINTS
- <verbatim constraint, or "None">

CONTEXT FOR CONTINUATION
- <what the next context needs to avoid re-deriving>
════════════════════════════════════════
\`\`\`

Limits: **ten** files in KEY FILES, prioritized, chosen from the git evidence rather than from what is easy to list. GOAL is **one** sentence. EXPLICIT CONSTRAINTS is verbatim or "None".

USER REQUESTS and EXPLICIT CONSTRAINTS are verbatim. Anything else is your summary and must read as one.

### Step 5 — Instructions to the operator

- Press \`n\` in the OpenCode TUI, or run \`opencode\` in a new terminal.
- Paste the HANDOFF CONTEXT block as the first message.
- Add one line: "Continue from the handoff context above. <your next task>".

### Constraints

- Do **not** try to create the new session programmatically. Produce the artifact; the operator starts the session.
- Do provide a summary that stands alone with no access to this session.
- Do use workspace-relative file paths.
- Do **not** include secrets, API keys, credentials, or tokens. If one appears in a file you read, reference the file, never the value.
- Do **not** exceed ten files in KEY FILES.
- Do keep GOAL to a single sentence.

## Mode: agent

This mode is the plugin's structured handoff path. Its contract is fixed in code, not by you — the child agent is guaranteed to receive exactly these sections, and the budget is enforced.

### Step 1 — Check what is already tracked

Call \`omo_status\`. If there are persisted plans, attempts, or recovery blockers, the handoff must carry them forward rather than restart the work.

Call \`omo_plans\` if a plan already exists for this objective. Continue it instead of creating a parallel one.

### Step 2 — Compose the assignment

Fill every field. The builder rejects an oversized mandatory block, so narrow the objective rather than hoping it fits.

- \`taskID\` — stable, kebab-case, meaningful across sessions.
- \`objective\` — one sentence. What done looks like.
- \`scope\` — the files and directories this child may touch, and nothing else.
- \`exitCriteria\` — each one independently checkable. Not "works correctly"; "\`bun test test/unit\` exits 0".
- \`constraints\` — permission limits, forbidden actions, things it must not touch.
- \`evidence\` — commands to run and the result that would count as proof.
- \`artifacts\` — file paths whose contents the child must read first.
- \`context\` — optional background. This is the only field that gets truncated if the budget is tight, and truncation is marked. Put the disposable material here.
- \`maxChars\` — optional. Defaults to 12000.

The mandatory block cannot be truncated. If it does not fit, the objective is too broad. Narrow the scope.

### Step 3 — Route and dispatch

Compose the handoff document, then hand it over with \`omo_delegate\`, passing the document as its
\`prompt\`. Dispatch is the only step that changes another session's context, so it is the only step
that is worth getting right.

Pick the route deliberately:

- \`route: { kind: "agent", id: "explore" }\` for investigation.
- \`route: { kind: "agent", id: "planner" }\` for a plan.
- \`route: { kind: "agent", id: "executor" }\` for a bounded implementation.
- \`route: { kind: "agent", id: "reviewer" }\` for an independent read.
- \`route: { kind: "agent", id: "verifier" }\` for an exit-criteria check.
- \`route: { kind: "category", id: "implement" }\` and friends for the fixed category routing, where the configured agent resolves it.

Choose \`background: true\` when you will keep working, \`background: false\` when you must wait.

Pass \`files\` to scope the child's reads. Pass \`skills\` only for skills that are genuinely installed — an unknown skill id fails the delegation rather than falling back.

If a category id is rejected as unknown, that is a configuration error, not a reason to invent a route.

### Step 4 — Hand off across sessions when the target is another session

For a sibling session rather than a child, record an invitation through the boulder tools: the work id, and the target session id. An invitation is not work until the target claims it. A self-handoff is refused, and a claimed invitation cannot be claimed twice.

### Constraints for agent mode

- Do **not** claim completion on the child's behalf. Report only what came back.
- Do **not** mark a step verified without the artifact or command output that verifies it.
- Do keep the objective narrow enough that the mandatory block fits the budget.`.trim()
