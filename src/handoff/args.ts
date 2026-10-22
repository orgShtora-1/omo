export type HandoffMode = "session" | "agent"

export type HandoffArgs = {
  to: HandoffMode
  /** Free text naming the next task, carried into the template's focus section. */
  focus: string
  root: string
}

export const HANDOFF_MODES: readonly HandoffMode[] = ["session", "agent"]

/**
 * Two destinations, and they are genuinely different contracts.
 *
 * - `session` reproduces the upstream shape: a self-contained text block a person pastes into a fresh
 *   OpenCode session.
 * - `agent` is this plugin's own structured path. `src/delegation/handoff.ts` already fixes the
 *   section layout and enforces a character budget, so the prompt has to tell the model to fill that
 *   contract rather than invent a second one.
 *
 * Default is `session`: it is the behaviour that works with no configuration.
 */
function member<T extends string>(allowed: readonly T[], value: string): T | undefined {
  return allowed.find((candidate) => candidate === value)
}

export function parseHandoffArgs(input: string, projectRoot: string): HandoffArgs {
  let to: HandoffMode = "session"
  const rest: string[] = []

  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith("--to=")) {
      const value = member(HANDOFF_MODES, token.slice("--to=".length))
      if (value === undefined) throw new Error(`--to must be one of: ${HANDOFF_MODES.join(", ")}`)
      to = value
      continue
    }
    if (token === "--to") throw new Error("--to needs a value, for example --to=agent")
    rest.push(token)
  }

  return { to, focus: rest.join(" "), root: projectRoot }
}
