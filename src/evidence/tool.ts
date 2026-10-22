/**
 * `omo_revision`: which revision each plan's stored evidence claims, and how far
 * that claim was corroborated, exposed as a native read-only tool.
 *
 * The tool owns no state. It reads plans through the runtime's own repository and
 * scope, hands them to the pure linkage derivation, and reports what came back. It
 * never completes, resumes, cancels or rewrites a step, and it never reports a
 * linkage for a plan it could not read.
 */

import type { Plugin } from "@opencode/plugin"
import type { Plan } from "../contracts"
import { buildRevisionLinkage, type RevisionLinkage, type RevisionLinkOptions } from "./revision"

export type RevisionLinkReport = {
  schemaVersion: 1
  generatedAt: number
  /** The linkage of each plan this session owns, in stored order. */
  plans: readonly RevisionLinkage[]
  /** Plans that could not be read at all, named by id. Never given a linkage. */
  unreadable: readonly string[]
  notes: readonly string[]
}

const DESCRIPTION =
  "Reports the code revision each plan's stored evidence claims, whether those " +
  "claims agree with each other, and which of them a probe could actually confirm. " +
  "A revision the probe could not decide is reported as unverifiable, never as " +
  "correct; a plan that cannot be read is named instead of reported as clean. It " +
  "changes no plan, completes no step and recommends no action."

export interface RevisionLinkToolOptions {
  /** Reads one stored plan through the runtime's repository and scope. */
  loadPlan: (sessionID: string, planID: string) => Promise<Plan | undefined>
  /** Lists the stored plans for a session. */
  listPlans: (sessionID: string) => Promise<readonly Plan[]>
  /**
   * Builds the corroboration probes for one call. Probes memoize what they observe,
   * so they are built per call rather than shared: no verdict outlives the call that
   * produced it, and the caller's signal reaches every spawn.
   */
  probes: (signal?: AbortSignal) => RevisionLinkOptions
}

const refuse = () => {
  throw new Error("aborted: revision linkage not collected")
}

export async function mountRevisionLink(
  ctx: Plugin.Context,
  options: RevisionLinkToolOptions,
): Promise<() => Promise<void>> {
  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omo", description: "OmO custom tools" })
    if (editor.get("omo_revision")) throw new Error("revision tool collision: omo_revision")
    editor.add({
      name: "revision",
      description: DESCRIPTION,
      options: { namespace: "omo", permission: "read" },
      output: {},
      input: {
        type: "object",
        properties: {
          planID: {
            type: "string",
            description: "One stored plan. Omit to report every plan this session owns.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(input, context) {
        const signal = context.signal
        if (signal?.aborted) refuse()
        // The schema is closed, but the payload still arrives as `unknown`, and a
        // host is not obliged to validate it first. A `planID` that is present and
        // not a single string is refused: widening it into "no plan named" would
        // silently report every stored plan for a request that named one.
        const args =
          typeof input === "object" && input !== null ? (input as { planID?: unknown }) : {}
        if ("planID" in args && typeof args.planID !== "string")
          throw new Error("planID must be a single string")
        const requested = typeof args.planID === "string" ? args.planID.trim() : ""
        // A named id that is blank after trimming names no plan either; reporting
        // every plan instead would answer a different question than the caller asked.
        if (requested === "" && typeof args.planID === "string")
          throw new Error("planID must name a plan, not a blank id")
        // The signal is merged in here rather than trusted to the probe factory:
        // whatever the caller returns, the derivation must be able to see a
        // cancellation raised during the probe phase.
        const probeOptions: RevisionLinkOptions = {
          ...options.probes(signal),
          ...(signal ? { signal } : {}),
        }
        const notes: string[] = []
        const unreadable: string[] = []
        const why = (error: unknown) => (error instanceof Error ? error.message : String(error))
        let candidates: readonly Plan[]
        if (requested) {
          try {
            const found = await options.loadPlan(context.sessionID, requested)
            candidates = found === undefined ? [] : [found]
            // Said only when the read succeeded and found nothing. A read that
            // failed proves the plan is unreadable, never that it is absent, so
            // the absence note must not ride along with the failure above.
            if (found === undefined)
              notes.push(`no plan with id ${requested} is stored for this session`)
          } catch (error) {
            // A failure that can be attributed to a named plan is recorded: the
            // report says which plan it could not read instead of reading as clean.
            unreadable.push(`${requested}: ${why(error)}`)
            notes.push(`plan ${requested} could not be read, so it has no linkage to report`)
            candidates = []
          }
        } else {
          try {
            candidates = await options.listPlans(context.sessionID)
          } catch (error) {
            // A store that cannot be enumerated is not reported at all: a report
            // that quietly covered fewer plans than it claims to would be a lie.
            throw new Error(`revision linkage could not read the plan store: ${why(error)}`)
          }
        }
        if (signal?.aborted) refuse()
        const plans: RevisionLinkage[] = []
        for (const candidate of candidates) {
          if (signal?.aborted) refuse()
          // Defensive: the repository is already scoped, and a plan belonging to
          // another session is excluded and counted rather than reported as ours.
          if (candidate.parentSessionID !== context.sessionID) {
            notes.push(
              `plan ${candidate.id} is owned by session ${candidate.parentSessionID} and was excluded`,
            )
            continue
          }
          plans.push(await buildRevisionLinkage(candidate, probeOptions))
        }
        // Re-checked after the probe phase, not just before it: up to five seconds
        // of spawning can pass between the last check above and here, and a report
        // that ignores a cancellation raised in that window would be reporting
        // work the caller already called off.
        if (signal?.aborted) refuse()
        const report: RevisionLinkReport = {
          schemaVersion: 1,
          generatedAt: Date.now(),
          plans,
          unreadable,
          notes,
        }
        return { output: report, content: JSON.stringify(report, null, 2) }
      },
    })
  })
  return async () => {
    await registration.dispose()
  }
}
