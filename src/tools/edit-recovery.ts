import type { Plugin } from "@opencode/plugin"

/**
 * Known Edit tool error patterns that indicate the AI made a mistake.
 * Mirrors the oh-my-openagent `edit-error-recovery` hook.
 */
export const EDIT_ERROR_PATTERNS = [
  "oldString and newString must be different",
  "oldString not found",
  "oldString found multiple times",
] as const

/**
 * System reminder injected when Edit tool fails due to AI mistake.
 * Short, direct, and commanding — forces immediate corrective action.
 */
export const EDIT_ERROR_REMINDER = `
[EDIT ERROR - IMMEDIATE ACTION REQUIRED]

You made an Edit mistake. STOP and do this NOW:

1. READ the file immediately to see its ACTUAL current state
2. VERIFY what the content really looks like (your assumption was wrong)
3. APOLOGIZE briefly to the user for the error
4. CONTINUE with corrected action based on the real file content

DO NOT attempt another edit until you've read and verified the file state.
`

interface AfterInput {
  readonly tool?: string
  readonly status: "completed" | "error"
  readonly result?: unknown
  readonly error?: unknown
}

/**
 * Detects Edit tool errors caused by AI mistakes and injects a recovery
 * reminder into the tool output. Fires on `tool.execute.after` — only for
 * the `edit` tool, only when the output contains a known error pattern.
 * Other tools and successful edits pass through untouched.
 */
export async function mountEditRecovery(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const registration = await ctx.tool.hook("execute.after", (input) => {
    const after = input as AfterInput
    if (after.tool !== "edit") return
    const output = (after.result as { output?: unknown })?.output
    if (typeof output !== "string") return
    const outputLower = output.toLowerCase()
    const hasEditError = EDIT_ERROR_PATTERNS.some((pattern) =>
      outputLower.includes(pattern.toLowerCase()),
    )
    if (hasEditError) {
      ;(after.result as { output: string }).output = `${output}\n${EDIT_ERROR_REMINDER}`
    }
  })
  return async () => {
    await registration.dispose()
  }
}
