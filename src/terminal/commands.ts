import type { Plugin } from "@opencode/plugin"
import { TmuxMonitor, type TmuxOptions } from "./tmux"

type Context = Plugin.Context
interface TerminalRequest {
  sessionID: string
  text: string
  signal?: AbortSignal
}
/** Implementations enforce plan/project ownership and reuse the runtime lifecycle. */
export interface TerminalService {
  plan(input: TerminalRequest): Promise<string>
  status(input: TerminalRequest): Promise<string>
  resume(input: TerminalRequest): Promise<string>
  cancel(input: TerminalRequest): Promise<string>
  compact(input: TerminalRequest): Promise<string>
  doctor(input: TerminalRequest): Promise<string>
  /** Optional: when present, an `omo-goal` command is registered. */
  goal?(input: TerminalRequest): Promise<string>
}
export interface TerminalOptions {
  enabled?: boolean
  tmux?: TmuxOptions
  /** An optional UI sink; default persists output without resuming the model. */
  publish?: (sessionID: string, text: string) => Promise<void>
}

/** Validate the generic terminal section before registration. Test seams stay programmatic. */
export function parseTerminalOptions(input: unknown): TerminalOptions {
  if (input === undefined) return { enabled: false }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("terminal must be an object")
  const object = input as Record<string, unknown>
  if (object.enabled !== undefined && typeof object.enabled !== "boolean")
    throw new TypeError("terminal.enabled must be boolean")
  let tmux: TmuxOptions | undefined
  if (object.tmux !== undefined) {
    if (!object.tmux || typeof object.tmux !== "object" || Array.isArray(object.tmux))
      throw new TypeError("terminal.tmux must be an object")
    const value = object.tmux as Record<string, unknown>
    if (value.enabled !== undefined && typeof value.enabled !== "boolean")
      throw new TypeError("terminal.tmux.enabled must be boolean")
    if (value.command !== undefined && typeof value.command !== "string")
      throw new TypeError("terminal.tmux.command must be a string")
    if (
      value.timeoutMs !== undefined &&
      (typeof value.timeoutMs !== "number" ||
        !Number.isInteger(value.timeoutMs) ||
        value.timeoutMs <= 0)
    )
      throw new TypeError("terminal.tmux.timeoutMs must be a positive integer")
    tmux = {
      enabled: value.enabled === true,
      command: value.command as string | undefined,
      timeoutMs: value.timeoutMs as number | undefined,
    }
  }
  return { enabled: object.enabled === true, tmux }
}

export async function mountTerminal(
  ctx: Context,
  service: TerminalService,
  options: TerminalOptions = {},
): Promise<() => Promise<void>> {
  if (!options.enabled) return async () => {}
  const controller = new AbortController()
  const active = new Set<Promise<void>>()
  const monitor = new TmuxMonitor(options.tmux ?? { enabled: false })
  const publish =
    options.publish ??
    (async (sessionID, text) => {
      await ctx.session.synthetic({
        sessionID,
        text,
        description: "OMO command result",
        resume: false,
      })
    })
  const names = ["plan", "status", "resume", "cancel", "compact", "doctor"] as const
  const commandNames: ReadonlyArray<(typeof names)[number] | "goal"> = service.goal
    ? [...names, "goal"]
    : [...names]
  const registration = await ctx.command.transform((editor) => {
    for (const name of commandNames) {
      const handler = service[name]
      if (!handler) throw new Error(`terminal service is missing ${name}`)
      editor.add({
        name: `omo-${name}`,
        description: `OMO ${name}; arguments are passed to the project runtime`,
        execute(input) {
          if (controller.signal.aborted) return Promise.reject(new Error("OMO terminal unloaded"))
          const action = (async () => {
            const text = await handler({
              sessionID: input.sessionID,
              text: input.prompt.text ?? "",
              signal: controller.signal,
            })
            if (controller.signal.aborted) return
            await publish(input.sessionID, text)
            if (name === "status" && options.tmux?.enabled)
              await monitor.open({ runID: input.sessionID, text })
          })()
          active.add(action)
          void action.finally(() => active.delete(action)).catch(() => {})
          return action
        },
      })
    }
  })
  let cleanup: Promise<void> | undefined
  return () =>
    (cleanup ??= (async () => {
      controller.abort()
      await registration.dispose()
      // Services must honor the injected signal; do not await a non-cooperative host indefinitely.
      await monitor.dispose()
    })())
}
