/**
 * `omo_blocked`: the blocked-runs panel, exposed as a native tool.
 *
 * The tool owns no state and derives everything from the status payload the
 * runtime already produces for `omo_status`. It reads that payload once, runs the
 * pure panel derivation, and returns observations. It never resumes, cancels or
 * retries anything, and it reports an unreadable section instead of an empty one.
 */

import type { Plugin } from "@opencode/plugin"
import { type BlockedPanel, buildBlockedPanel } from "./panel.js"

const DESCRIPTION =
  "Panel of runs and plan steps that durable state records as blocked, with the " +
  "reason recorded for each one verbatim. Counts in-flight attempts by phase " +
  "without calling them blocked, reports any section it could not read instead of " +
  "showing it as empty, and excludes plans owned by another session. It resumes " +
  "nothing, retries nothing and recommends no action."

export interface BlockedPanelOptions {
  /** The existing runtime status source. Called once per panel; never reimplemented. */
  status: (parentID: string) => Promise<unknown>
}

export async function mountBlockedPanel(
  ctx: Plugin.Context,
  options: BlockedPanelOptions,
): Promise<() => Promise<void>> {
  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omo", description: "OmO custom tools" })
    if (editor.get("omo_blocked")) throw new Error("blocked panel tool collision: omo_blocked")
    editor.add({
      name: "blocked",
      description: DESCRIPTION,
      options: { namespace: "omo", permission: "read" },
      output: {},
      input: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      async execute(_input, context) {
        // The caller's signal is authoritative: an aborted tool call collects
        // nothing rather than reporting a panel the caller no longer wants.
        if (context.signal?.aborted) throw new Error("aborted: blocked-runs panel not collected")
        const payload = await options.status(context.sessionID)
        if (context.signal?.aborted) throw new Error("aborted: blocked-runs panel not collected")
        const panel: BlockedPanel = buildBlockedPanel(payload, {
          parentSessionID: context.sessionID,
          now: Date.now(),
        })
        return { output: panel, content: JSON.stringify(panel, null, 2) }
      },
    })
  })
  return async () => {
    await registration.dispose()
  }
}
