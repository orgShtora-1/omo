type DeepIniMode = "update" | "create-new" | "dry-run"

export interface DeepIniArgs {
  mode: DeepIniMode
  maxDepth: number
  root: string
  focus: string
}

/** Beyond this the generated hierarchy stops paying for itself; the prompt also caps itself. */
export const MAX_DEPTH_CEILING = 6

export const DEFAULT_MAX_DEPTH = 3

/**
 * Flags are parsed here, in the plugin, never delegated to the model: a hallucinated `--max-depth=99`
 * must not become a prompt the agent tries to honour.
 *
 * `--create-new` deletes nothing on its own. It only widens the prompt's licence to rewrite
 * existing files; the body still has to read and record them first.
 */
export function parseDeepIniArgs(input: string, projectRoot: string): DeepIniArgs {
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  let mode: DeepIniMode = "update"
  let maxDepth = DEFAULT_MAX_DEPTH
  let root: string | undefined
  const focus: string[] = []
  for (const token of tokens) {
    if (token === "--create-new") mode = "create-new"
    else if (token === "--update") mode = "update"
    else if (token === "--dry-run") mode = "dry-run"
    else if (token.startsWith("--max-depth=")) {
      const parsed = Number.parseInt(token.slice("--max-depth=".length), 10)
      if (Number.isNaN(parsed) || parsed < 1 || parsed > MAX_DEPTH_CEILING)
        throw new Error(`--max-depth must be an integer between 1 and ${MAX_DEPTH_CEILING}`)
      maxDepth = parsed
    } else if (token.startsWith("--root=")) {
      const value = token.slice("--root=".length).trim()
      if (!value) throw new Error("--root requires a non-empty path")
      root = value
    } else focus.push(token)
  }
  return { mode, maxDepth, root: root ?? projectRoot, focus: focus.join(" ") }
}
