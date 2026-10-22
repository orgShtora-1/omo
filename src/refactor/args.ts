export type RefactorScope = "file" | "module" | "project"
export type RefactorStrategy = "safe" | "aggressive"

export type RefactorArgs = {
  /** What to refactor. Defaults to a sentinel that forces the template's intent gate. */
  target: string
  scope: RefactorScope
  strategy: RefactorStrategy
  /** Everything that was neither a flag nor the target. */
  focus: string
  root: string
}

export const REFACTOR_SCOPES: readonly RefactorScope[] = ["file", "module", "project"]
export const REFACTOR_STRATEGIES: readonly RefactorStrategy[] = ["safe", "aggressive"]

/**
 * `/refactor` is the one command whose default behaviour has to be a refusal. Without an explicit
 * target there is nothing to ground the codemap in, so we do not guess a scope; the sentinel below
 * makes the template's Phase 0 ask rather than proceed.
 */
const UNSPECIFIED_TARGET =
  "UNSPECIFIED - no target was given. Run the Phase 0 intent gate and ask which symbol or module to refactor before touching anything."

function member<T extends string>(allowed: readonly T[], value: string): T | undefined {
  return allowed.find((candidate) => candidate === value)
}

export function parseRefactorArgs(input: string, projectRoot: string): RefactorArgs {
  let scope: RefactorScope = "module"
  let strategy: RefactorStrategy = "safe"
  const rest: string[] = []

  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith("--scope=")) {
      const value = member(REFACTOR_SCOPES, token.slice("--scope=".length))
      if (value === undefined)
        throw new Error(`--scope must be one of: ${REFACTOR_SCOPES.join(", ")}`)
      scope = value
      continue
    }
    if (token.startsWith("--strategy=")) {
      const value = member(REFACTOR_STRATEGIES, token.slice("--strategy=".length))
      if (value === undefined)
        throw new Error(`--strategy must be one of: ${REFACTOR_STRATEGIES.join(", ")}`)
      strategy = value
      continue
    }
    // A bare --scope / --strategy with no value is a typo, not a target.
    if (token === "--scope" || token === "--strategy")
      throw new Error(
        `${token} needs a value, for example ${token}=${token === "--scope" ? "file" : "safe"}`,
      )
    rest.push(token)
  }

  const target = rest[0]
  return {
    target: target === undefined ? UNSPECIFIED_TARGET : target,
    scope,
    strategy,
    focus: rest.slice(1).join(" "),
    root: projectRoot,
  }
}
