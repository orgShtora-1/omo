/**
 * Blocked-runs panel.
 *
 * The panel is a pure derivation over the payload the runtime already exposes
 * through `RuntimeServices.status`. It owns no state, opens no database and
 * repairs nothing: it reports what durable state records, and it reports
 * unreadable input as unreadable so a broken section can never read as
 * "nothing is blocked".
 */

type PanelStatus = "clear" | "blocked" | "unknown"

type BlockedRunEntry = {
  attemptID: string | null
  taskID: string | null
  sessionID: string | null
  phase: string
  /** Recorded verbatim, or null when durable state records no reason. */
  reason: string | null
  updatedAt: number | null
  ageMs: number | null
}

type BlockedStepEntry = {
  planID: string
  stepID: string
  objective: string | null
  /** Recorded verbatim, or null when durable state records no reason. */
  reason: string | null
  planUpdatedAt: number | null
  lastAttemptID: string | null
}

type UnresolvedPhases = {
  intent: number
  prepared: number
  admitted: number
  blocked: number
}

export type BlockedPanel = {
  schemaVersion: 1
  /**
   * blocked — durable state records at least one blocked run or blocked step.
   * unknown — at least one section could not be read, so the panel cannot claim
   *           a complete picture even when nothing blocked was found.
   * clear   — every section was read, nothing blocked was recorded.
   */
  status: PanelStatus
  generatedAt: number
  parentSessionID: string
  blockedRuns: readonly BlockedRunEntry[]
  blockedSteps: readonly BlockedStepEntry[]
  /** Counts by durable phase; in-flight phases are counted, never called blocked. */
  unresolved: UnresolvedPhases
  /** One entry per unreadable input, naming the exact path that could not be read. */
  unreadable: readonly string[]
  foreignPlans: number
  notes: readonly string[]
}

export type BlockedPanelOptions = {
  parentSessionID: string
  now: number
}

const UNRESOLVED_PHASES = ["intent", "prepared", "admitted", "blocked"] as const
const SCOPING_NOTE =
  "run entries arrive pre-filtered to the requested parent by the runtime status source; the panel does not re-verify run scoping"
const REASON_NOTE =
  "an absent recorded reason is not an absence of cause; the panel reports the record as it stands"

type Unknown = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null => (typeof value === "string" ? value : null)

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const isUnresolvedPhase = (value: string): value is keyof UnresolvedPhases =>
  (UNRESOLVED_PHASES as readonly string[]).includes(value)

export function buildBlockedPanel(payload: unknown, options: BlockedPanelOptions): BlockedPanel {
  const { parentSessionID, now } = options
  const unreadable: string[] = []
  const notes: string[] = [SCOPING_NOTE]
  const unresolved: UnresolvedPhases = { intent: 0, prepared: 0, admitted: 0, blocked: 0 }
  const blockedRuns: BlockedRunEntry[] = []

  const age = (updatedAt: number | null) =>
    updatedAt === null ? null : Math.max(0, now - updatedAt)

  if (!isRecord(payload)) {
    unreadable.push("status: expected an object")
    return {
      schemaVersion: 1,
      status: "unknown",
      generatedAt: now,
      parentSessionID,
      blockedRuns,
      blockedSteps: [],
      unresolved,
      unreadable,
      foreignPlans: 0,
      notes,
    }
  }

  if ("runs" in payload) {
    const runs = payload.runs
    if (!Array.isArray(runs)) unreadable.push("runs: expected an array")
    else
      runs.forEach((run, index) => {
        if (!isRecord(run)) {
          unreadable.push(`runs[${index}]: expected an object`)
          return
        }
        const phase = text(run.phase)
        if (phase === null) {
          unreadable.push(`runs[${index}]: phase is not a string`)
          return
        }
        if (isUnresolvedPhase(phase)) unresolved[phase] += 1
        if (phase !== "blocked") return
        const attemptID = text(run.attemptID)
        // A blocked record without its identity is still surfaced, and the
        // missing identity keeps the panel from claiming a complete picture.
        if (attemptID === null) unreadable.push(`runs[${index}]: attemptID is not a string`)
        const updatedAt = finite(run.updatedAt)
        blockedRuns.push({
          attemptID,
          taskID: text(run.taskID),
          sessionID: text(run.sessionID),
          phase,
          reason: text(run.error),
          updatedAt,
          ageMs: age(updatedAt),
        })
      })
  } else unreadable.push("runs: expected an array")

  const blockedSteps: BlockedStepEntry[] = []
  let foreignPlans = 0
  if ("plans" in payload) {
    const plans = payload.plans
    if (!Array.isArray(plans)) unreadable.push("plans: expected an array")
    else
      plans.forEach((plan, index) => {
        if (!isRecord(plan)) {
          unreadable.push(`plans[${index}]: expected an object`)
          return
        }
        const owner = text(plan.parentSessionID)
        if (owner === null) {
          unreadable.push(`plans[${index}].parentSessionID: expected a string`)
          return
        }
        if (owner !== parentSessionID) {
          foreignPlans += 1
          return
        }
        const planID = text(plan.id)
        if (planID === null) {
          unreadable.push(`plans[${index}].id: expected a string`)
          return
        }
        const planUpdatedAt = finite(plan.updatedAt)
        const steps = plan.steps
        if (!Array.isArray(steps)) {
          unreadable.push(`plans[${index}].steps: expected an array`)
          return
        }
        steps.forEach((step, stepIndex) => {
          if (!isRecord(step)) {
            unreadable.push(`plans[${index}].steps[${stepIndex}]: expected an object`)
            return
          }
          const stepID = text(step.id)
          if (stepID === null) {
            unreadable.push(`plans[${index}].steps[${stepIndex}].id: expected a string`)
            return
          }
          if (step.state !== "blocked") return
          const attempts = Array.isArray(step.attempts) ? step.attempts : []
          const lastAttempt = attempts.length ? attempts[attempts.length - 1] : undefined
          blockedSteps.push({
            planID,
            stepID,
            objective: text(step.objective),
            reason: text(step.reason),
            planUpdatedAt,
            lastAttemptID: isRecord(lastAttempt) ? text(lastAttempt.attemptID) : null,
          })
        })
      })
  } else unreadable.push("plans: expected an array")

  blockedRuns.sort(
    (a, b) =>
      (a.updatedAt ?? Number.POSITIVE_INFINITY) - (b.updatedAt ?? Number.POSITIVE_INFINITY) ||
      (a.attemptID ?? "").localeCompare(b.attemptID ?? ""),
  )
  blockedSteps.sort((a, b) => a.planID.localeCompare(b.planID) || a.stepID.localeCompare(b.stepID))
  const unreasoned =
    blockedRuns.filter((entry) => entry.reason === null || entry.attemptID === null).length +
    blockedSteps.filter((entry) => entry.reason === null).length
  if (unreasoned > 0)
    notes.push(`${unreasoned} blocked entries carry no recorded reason; ${REASON_NOTE}`)
  if (foreignPlans > 0)
    notes.push(
      `${foreignPlans} ${foreignPlans === 1 ? "plan" : "plans"} owned by another session observed and excluded`,
    )

  return {
    schemaVersion: 1,
    status:
      blockedRuns.length > 0 || blockedSteps.length > 0
        ? "blocked"
        : unreadable.length > 0
          ? "unknown"
          : "clear",
    generatedAt: now,
    parentSessionID,
    blockedRuns,
    blockedSteps,
    unresolved,
    unreadable,
    foreignPlans,
    notes,
  }
}
