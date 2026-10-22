/**
 * `omo_doctor`: the read-only compatibility diagnosis, exposed as a native tool.
 *
 * It registers with permission "read" because it changes nothing: it observes
 * the host, spawns only bounded version probes, lists pending permission
 * requests, and returns a report. It never creates a permission request, never
 * writes state, and never restarts anything.
 */

import type { Plugin } from "@opencode/plugin"
import { type DoctorReport, diagnose } from "./diagnose.js"
import { type HostDoctorOptions, hostDoctorInputs } from "./host.js"

const DESCRIPTION =
  "Read-only compatibility diagnosis of the environment OmO runs in. Reports host " +
  "and SDK versions, required host capabilities, model availability, Git, optional " +
  "services, configured MCP servers against the recommended template and pending permission requests as observed facts, then names exactly " +
  "which features the failures block and which stay independent. A missing optional " +
  "service degrades one feature; a missing required capability is an incompatibility; " +
  "an unreadable probe is reported as unknown rather than as a failure. It installs " +
  "nothing, mutates nothing and grants no authorization."

export interface DoctorToolOptions extends HostDoctorOptions {}

/** Register the diagnosis tool. The caller keeps ownership of the host context. */
export async function mountDoctor(
  ctx: Plugin.Context,
  options: DoctorToolOptions = {},
): Promise<() => Promise<void>> {
  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omo", description: "OmO custom tools" })
    if (editor.get("omo_doctor")) throw new Error("doctor tool collision: omo_doctor")
    editor.add({
      name: "doctor",
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
        const report: DoctorReport = await diagnose({
          ...hostDoctorInputs(ctx, context.sessionID, options),
          // The caller's signal is authoritative: an aborted tool call must not
          // finish probing.
          ...(context.signal ? { signal: context.signal } : {}),
        })
        return { output: report, content: JSON.stringify(report, null, 2) }
      },
    })
  })
  return async () => {
    await registration.dispose()
  }
}
