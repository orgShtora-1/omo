/**
 * `omo_monitor` and `omo_look_at`: the read-only parity surface over the
 * tmux status mirror. `TmuxMonitor` (see ./tmux.ts) mirrors the text of the
 * terminal status command into private tmux sessions; these tools only ever
 * observe that mirror. They never open, close or mutate anything, and they
 * fail closed: when the monitor cannot serve reads the tools report
 * `monitor-unavailable: <reason>` instead of inventing a snapshot.
 */

import type { Plugin } from "@opencode/plugin"
import { parseTerminalOptions } from "./commands"
import { activeMonitors, type TmuxMonitor } from "./tmux"

interface MonitorAvailability {
  available: boolean
  reason?: string
}
interface MonitorSessionRef {
  /** The run the mirror follows; for terminal status this is the sessionID. */
  runID: string
  /** The tmux session name the monitor mirrors the run into. */
  name: string
}
/** The injectable seam: anything that can report a mirror satisfies it. */
export interface MonitorView {
  availability(): MonitorAvailability
  mirrored(): MonitorSessionRef[]
  capture(runID: string): Promise<string>
}
export interface MonitorStatusReport {
  available: true
  sessions: MonitorSessionRef[]
}
export interface MonitorCaptureReport {
  runID: string
  name: string
  text: string
}

function requiredSessionID(sessionID: string | undefined): string {
  if (typeof sessionID !== "string" || !sessionID.trim()) throw new Error("sessionID required")
  return sessionID
}

function unavailable(availability: MonitorAvailability): Error {
  return new Error(`monitor-unavailable: ${availability.reason ?? "tmux unavailable"}`)
}

/** Report the sessions the monitor mirrors, or just the one asked for. */
export function monitorStatus(view: MonitorView, sessionID?: string): MonitorStatusReport {
  if (sessionID !== undefined) requiredSessionID(sessionID)
  const availability = view.availability()
  if (!availability.available) throw unavailable(availability)
  const mirrored = view.mirrored()
  if (sessionID === undefined) return { available: true, sessions: mirrored }
  const sessions = mirrored.filter((session) => session.runID === sessionID)
  if (!sessions.length) throw new Error(`unknown-session: ${sessionID}`)
  return { available: true, sessions }
}

/** Read the most recent mirrored text of one session the monitor can see. */
export async function lookAtSession(
  view: MonitorView,
  sessionID?: string,
): Promise<MonitorCaptureReport> {
  const runID = requiredSessionID(sessionID)
  const availability = view.availability()
  if (!availability.available) throw unavailable(availability)
  const session = view.mirrored().find((candidate) => candidate.runID === runID)
  if (!session) throw new Error(`unknown-session: ${runID}`)
  let text: string
  try {
    text = await view.capture(runID)
  } catch (error) {
    throw new Error(`capture-failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { runID: session.runID, name: session.name, text }
}

/**
 * The view the mounted tools read: the aggregate of every live TmuxMonitor,
 * because the terminal commands open their sessions on their own instance.
 * An empty aggregate fails closed: no monitor means nothing can be reported.
 */
export function liveMonitorView(monitors: readonly TmuxMonitor[] = activeMonitors()): MonitorView {
  return {
    availability() {
      if (!monitors.length) return { available: false, reason: "no tmux monitor is active" }
      const reasons: string[] = []
      for (const monitor of monitors) {
        const verdict = monitor.availability()
        if (verdict.available) return { available: true }
        if (verdict.reason !== undefined && !reasons.includes(verdict.reason))
          reasons.push(verdict.reason)
      }
      return { available: false, reason: reasons.join("; ") || "tmux unavailable" }
    },
    mirrored() {
      const sessions = new Map<string, MonitorSessionRef>()
      for (const monitor of monitors)
        for (const session of monitor.mirrored())
          if (!sessions.has(session.runID)) sessions.set(session.runID, session)
      return [...sessions.values()]
    },
    async capture(runID) {
      for (const monitor of monitors)
        if (monitor.mirrored().some((session) => session.runID === runID))
          return await monitor.capture(runID)
      throw new Error(`unknown-session: ${runID}`)
    },
  }
}

export interface MonitorMountOptions {
  /** Raw terminal config section, parsed with the same rules as the commands. */
  terminal?: Record<string, unknown>
  /** Test seam for the observed view; defaults to the live monitor aggregate. */
  view?: () => MonitorView
}

/** Register the read-only monitor tools. The caller keeps the host context. */
export async function mountMonitor(
  ctx: Plugin.Context,
  options: MonitorMountOptions = {},
): Promise<() => Promise<void>> {
  const terminal = parseTerminalOptions(options.terminal ?? { enabled: true })
  if (!terminal.enabled) return async () => {}
  const view = options.view ?? (() => liveMonitorView())
  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omo", description: "OmO custom tools" })
    if (editor.get("omo_monitor") || editor.get("omo_look_at"))
      throw new Error("monitor tool collision")
    editor.add({
      name: "monitor",
      description:
        "Read-only view of the tmux status mirror: reports the sessions the monitor is " +
        "currently mirroring, or one specified session. Fails closed with " +
        "monitor-unavailable when tmux is disabled or unsupported on this platform.",
      options: { namespace: "omo", permission: "read" },
      output: {},
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
      async execute(input) {
        const sessionID = (input as { sessionID?: string } | undefined)?.sessionID
        const payload = JSON.stringify(monitorStatus(view(), sessionID))
        return { output: payload, content: payload }
      },
    })
    editor.add({
      name: "look_at",
      description:
        "Read the most recent mirrored status text of one session the monitor can see. " +
        "Fails closed with monitor-unavailable when the monitor cannot serve reads, and " +
        "unknown-session when the monitor is not mirroring the requested session.",
      options: { namespace: "omo", permission: "read" },
      output: {},
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      async execute(input) {
        const sessionID = (input as { sessionID?: string } | undefined)?.sessionID
        const payload = JSON.stringify(await lookAtSession(view(), sessionID))
        return { output: payload, content: payload }
      },
    })
  })
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    await registration.dispose()
  }
}
