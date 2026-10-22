/**
 * Body of the `/deep-ini` command.
 *
 * Shipped as a TypeScript module rather than a `.txt` asset on purpose: `tsconfig.json` declares
 * no resolution for `*.txt` and `scripts/build.ts` copies no assets, so importing one would need
 * both a `declare module "*.txt"` shim and a copy step. This matches the existing convention in
 * `src/agents/prompts.ts`.
 *
 * `${root}`, `${mode}` and `${maxDepth}` are placeholders left intact on purpose and
 * substituted by `renderDeepIniTemplate`. Unknown placeholders are preserved verbatim, so a typo
 * here fails a test instead of silently rendering an empty string.
 *
 * Origin: behavior reference `code-yeongyu/oh-my-openagent` `init-deep` (license SUL-1.0).
 * The prose is original; only the scoring weights and numeric thresholds are reused, because those
 * are the algorithm itself.
 */
export const DEEP_INI_TEMPLATE = `Generate or refresh a hierarchical \`AGENTS.md\` knowledge base for the repository at \`\${root}\`.

Mode: \`\${mode}\`.
Maximum directory depth below root: \`\${maxDepth}\`.

This is a DEEP init, not a guided walkthrough. A single root file is a failure. The deliverable
is a scored, minimal set of \`AGENTS.md\` files covering every directory that genuinely deserves
its own instruction sheet, plus a root file that links and summarizes them.

## Non-negotiable grounding mandate

No claim about this repository may come from convention, from the shape of a file name, or from
what a similar project usually does. Every factual statement in a generated file must trace to
something you actually observed.

Grounding tools, in priority order:

1. \`omo_lsp_symbols\`, \`omo_lsp_references\`, \`omo_lsp_workspace_symbols\`, \`omo_lsp_definition\`
   when the OMO LSP subsystem is enabled. These give measured symbol counts and reference
   counts. If they are unavailable, say so in \`NOTES\` and mark reference centrality as
   unmeasured. Never invent a number.
2. \`grep\` and \`glob\` for structure, imports, config keys, and literal text.
3. \`read\` for the specific files that matter. Read the wiring files, not random leaves.

Executable sources outrank prose. When \`README\`, comments, or an existing \`AGENTS.md\` disagree
with \`package.json\`, \`tsconfig.json\`, or the task runner, the executable source
wins and the file you write must match the executable source.

## Phase tracking

Track all five phases below explicitly. Create the checklist before starting work, then move each from
\`in_progress\` to \`completed\` in real time. Never create them retroactively and never mark a phase
complete while its work is still outstanding.

- \`discovery\` - measure and fan out
- \`scoring\` - decide which directories get files
- \`generate\` - write the files
- \`review\` - remove redundancy and generic filler
- \`report\` - emit the completion block

## Phase 1: measure, then fan out proportionally

Do NOT start with a fixed number of agents. Measure first, then size the fan-out from the
measurement. A static agent count is a bug.

Measure with shell commands available to you (\`find\`, \`wc -l\`, or the equivalents):

- \`total_files\` - source files, excluding \`.git\`, \`node_modules\`, \`dist\`, \`build\`, \`target\`,
  \`vendor\`, \`.venv\`, \`__pycache__\`, and coverage output
- \`total_lines\` - sum of lines over those files
- \`large_files\` - count of source files over 500 lines
- \`max_depth\` - deepest directory depth below root
- \`packages\` - count of declared workspaces or packages, from the root manifest and workspace config
- \`languages\` - distinct languages, by file extension concentration

Derive the exploration agent count:

\`\`\`
agents = 6
       + floor(total_files / 100)
       + floor(total_lines / 10000)
       + (max_depth >= 4 ? 2 : 0)
       + (large_files > 10 ? 1 : 0)
       + packages            # one per workspace package in a monorepo
       + max(0, languages - 1)
\`\`\`

Cap the total. Past roughly twenty agents, widen each agent's scope instead of adding more, and
say in \`NOTES\` that the fan-out was capped.

Launch the exploration agents in ONE batch, in the background, so they run concurrently. Give
each a disjoint question and require measured evidence:

- directory structure and package boundaries
- real entry points and the execution flow that connects them
- conventions that deviate from the language and framework defaults
- anti-patterns: what a competent agent would get wrong here
- build, test, lint, and typecheck commands, with the exact required ordering
- testing quirks: fixtures, prerequisites, expensive or flaky suites, snapshot workflows
- code hotspots: the large and heavily referenced files

Use the native \`subagent\` tool with \`background\` enabled so the main session keeps working while
they run. Collect every result before leaving Phase 1.

Concurrently, in the main session, do the work that must not be delegated:

1. Census of the tree: depth histogram, top directories by file count, extension concentration.
2. Read EVERY existing \`AGENTS.md\` and \`CLAUDE.md\` in the tree into a map keyed by path. Read them
   even in recreate mode, because what they contain is evidence about the repository.
3. Build a code map: for each candidate module, its exported symbols, their locations, and their
   reference counts, measured with the LSP tools where available.

## Phase 2: score every candidate directory

Score each directory with this weighted matrix. Weights are multipliers; a factor scores high only
when it clears its threshold.

| Factor | Weight | High threshold |
| --- | --- | --- |
| file count | 3x | more than 20 |
| subdirectory count | 2x | more than 5 |
| code ratio | 2x | more than 70% of files are source |
| unique patterns | 1x | directory owns its own config, schema, or manifest |
| module boundary | 2x | declares an \`index\`/\`__init__\`/\`mod\`/\`main\` entry surface |
| symbol density | 2x | more than 30 exported symbols |
| export count | 2x | more than 10 exports |
| reference centrality | 3x | more than 20 inbound references |

Decision rules:

- the repository root ALWAYS gets a file
- score above 15 - create a file
- score 8 to 15 - create a file only if the directory is a genuinely distinct domain, and say why
- score below 8 - skip it; the parent file covers it

Emit the decision as a single structure before writing anything:

\`\`\`
AGENTS_LOCATIONS = [
  { path, type, score, reason }
]
\`\`\`

\`type\` is \`root\` or \`subdir\`. \`reason\` is one clause citing a measured fact, never a feeling.

If the result is only the root file, the scoring is probably too weak. Re-check the thresholds
before accepting a single-file outcome, and note in \`NOTES\` when a single file is genuinely the
right answer.

## Phase 3: write the files

Write the root file first, then the subdirectory files concurrently across disjoint scopes.

File-writing rule, with no exceptions:

- file already exists -> edit it in place
- file does not exist -> create it
- never write over an existing file wholesale

### Root file, 50 to 150 lines

\`\`\`
<!-- Generated by /deep-ini. Commit <sha>, branch <branch>. Regenerate with /deep-ini. -->

# <repository name>

## OVERVIEW
Two to four sentences. What this system does and what a newcomer gets wrong first.

## STRUCTURE
A tree. Annotate every entry with its purpose. Omit files whose purpose is obvious from the
name. Nested \`AGENTS.md\` files get a link.

## WHERE TO LOOK
Table: Concern | Path | Notes

## CODE MAP
Table: Symbol | Kind | Location | Refs | Role
Refs is a measured reference count, or \`n/m\` when LSP was unavailable.

## CONVENTIONS
Only what deviates from the language and framework default. If a convention is the default, it
does not belong here.

## ANTI-PATTERNS
What a competent agent would get wrong in THIS repository, with the file that proves it.

## UNIQUE STYLES
Naming, error handling, or layout choices unique to this codebase.

## COMMANDS
Exact commands, including the order they must run in. Include how to run a single test or a
single package.

## NOTES
Measurement limits: which LSP tools were unavailable, where the fan-out was capped, what could
not be verified.
\`\`\`

### Subdirectory file, 30 to 80 lines

Sections: \`OVERVIEW\`, \`STRUCTURE\` only when the directory has more than five subdirectories,
\`WHERE TO LOOK\`, \`CONVENTIONS\` only when they differ from the parent, \`ANTI-PATTERNS\`.

Hard rule: a child file NEVER restates anything the parent already says. The parent is the index;
the child is the detail. Repeating the parent is a defect, not thoroughness.

Style is telegraphic. Fragments, not sentences. No filler sentences, no restatement of the task,
no offer to help further.

## Phase 4: review

Re-read every file you wrote and cut:

- generic software advice that is true of any repository
- anything duplicated from the parent file
- anything unverified
- anything past the line budget

If a section has nothing project-specific left, delete the section rather than padding it.

## Phase 5: report

Emit exactly this block at the end:

\`\`\`
=== deep-ini Complete ===
mode: \${mode}
root: \${root}
directories analyzed: <n>
files created: <n>
files updated: <n>
[OK] <path> (root, <n> lines)
[OK] <path> (subdir, <n> lines)
hierarchy:
<tree of AGENTS.md paths with line counts>
=================================
\`\`\`

## Anti-patterns

Any of the following means the run failed:

- a fixed agent count that did not respond to the measured size
- sequential exploration instead of concurrent background fan-out
- ignoring existing \`AGENTS.md\` files, or overwriting them
- documenting every directory instead of the scored subset
- a child file that repeats its parent
- generic advice that would be true in any repository
- unmeasured numbers presented as measured
- prose longer than the line budget`
