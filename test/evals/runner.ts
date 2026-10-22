/**
 * Versioned behavioural eval runner.
 *
 * An eval here is a *scenario over real product behaviour*: it drives the shipped
 * seams (transition rules, permission evaluation, journal phases, the doctor and
 * the blocked panel) and asserts an invariant. Scenarios never re-implement the
 * behaviour under test and never assert against a mock of it.
 *
 * The runner exists to make coverage claims falsifiable:
 *
 * - a declared `ledger` of behaviours is compared against what actually ran, so a
 *   behaviour nobody exercises surfaces as `uncovered` instead of vanishing;
 * - a behaviour covered only by a skipped or failed scenario is still uncovered,
 *   so "the gate was not authorized" can never read as "the gate holds";
 * - a scenario that declines to run from inside its own body is a FAILURE, not a
 *   skip, because a body that silently returns is a false coverage claim;
 * - nothing is inferred from a missing or malformed input. An unreadable
 *   scenario, a duplicated id and an empty suite all fail.
 *
 * Scenarios are versioned individually (`version`) and the suite itself is
 * versioned (`suiteVersion`) so a behaviour change is a reviewable diff rather
 * than an invisible edit to an assertion.
 *
 * Paid inference is never required: every shipped scenario is deterministic and
 * offline. Scenarios that need an authorized live gate declare `requires`, and an
 * unmet gate degrades the suite instead of passing it.
 */

export type EvalStatus = "pass" | "fail" | "skipped"
export type SuiteStatus = "pass" | "degraded" | "fail"

export type EvalScenario = {
  /** Stable, unique within the suite. Duplicates fail; they never overwrite. */
  id: string
  /** Scenario contract version. Bump when the asserted invariant changes. */
  version: number
  title: string
  /** Ledger behaviours this scenario exercises. An empty list declares nothing. */
  covers: readonly string[]
  /**
   * A precondition the *environment* must satisfy before the body may run, named
   * by environment variable. Absent or empty variable value means the body is not
   * invoked and the scenario is skipped with the declared note.
   */
  requires?: { env: string; note: string }
  run: () => void | Promise<void>
}

export type EvalResult = {
  id: string
  version: number
  title: string
  status: EvalStatus
  covers: readonly string[]
  /** Observed reason. Always present for fail/skipped; absent for pass. */
  detail?: string
}

export type EvalReport = {
  schemaVersion: 1
  suiteVersion: number
  status: SuiteStatus
  ledger: readonly string[]
  results: readonly EvalResult[]
  uncovered: readonly string[]
}

export type EvalOptions = {
  suiteVersion: number
  ledger: readonly string[]
  /** Environment used to evaluate `requires`. Injected so gating is testable. */
  env: Record<string, string | undefined>
}

/**
 * Raised by a scenario body to refuse to run. It is never treated as a skip:
 * only the runner may skip, and only for an unmet declared precondition.
 */
export class EvalDeclined extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "EvalDeclined"
  }
}

const reasonOf = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "the scenario failed without a stated reason"
}

const declared = (error: unknown): boolean => error instanceof EvalDeclined

export async function runEvals(
  scenarios: readonly EvalScenario[],
  options: EvalOptions,
): Promise<EvalReport> {
  const results: EvalResult[] = []
  const executed = new Set<string>()
  for (const scenario of scenarios) {
    const base = {
      id: scenario.id,
      version: scenario.version,
      title: scenario.title,
      covers: [...scenario.covers],
    }
    if (executed.has(scenario.id)) {
      results.push({
        ...base,
        status: "fail",
        detail: `duplicate scenario id ${scenario.id}; the first declaration still ran`,
      })
      continue
    }
    executed.add(scenario.id)
    const gate = scenario.requires
    if (gate && !options.env[gate.env]?.trim()) {
      results.push({ ...base, status: "skipped", detail: gate.note })
      continue
    }
    try {
      await scenario.run()
      results.push({ ...base, status: "pass" })
    } catch (error) {
      results.push({
        ...base,
        status: "fail",
        detail: declared(error)
          ? gate
            ? `${scenario.id} declined to run while its declared precondition ${gate.env} was met: ${reasonOf(error)}`
            : `${scenario.id} declined to run with no declared precondition: ${reasonOf(error)}`
          : reasonOf(error),
      })
    }
  }
  const proven = new Set(
    results.filter((item) => item.status === "pass").flatMap((item) => item.covers),
  )
  const uncovered = options.ledger.filter((behaviour) => !proven.has(behaviour))
  const failed = results.some((item) => item.status === "fail")
  const skipped = results.some((item) => item.status === "skipped")
  const status: SuiteStatus =
    failed || uncovered.length > 0 || results.length === 0 ? "fail" : skipped ? "degraded" : "pass"
  return {
    schemaVersion: 1,
    suiteVersion: options.suiteVersion,
    status,
    ledger: [...options.ledger],
    results,
    uncovered,
  }
}
