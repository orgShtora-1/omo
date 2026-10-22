import type { Plugin } from "@opencode/plugin"
import { eventDiagnostics } from "../events/diagnostics"
import { idleSignalFrom } from "../events/idle"
import { startQuietPrompter } from "../events/quiet"
import { createGoalContinuation } from "./continuation"
import {
  type Goal,
  goalDirectory,
  openGoalStore,
  type RecoveryDisposition,
  validateLimits,
} from "./store"

const CREATE_DESCRIPTION =
  "Create or replace the active goal for the current session. Use this when the " +
  "user asks you to set a goal, or when you decide a new high-level objective is " +
  "needed. The objective should be concise (under 2000 characters) and describe " +
  "the desired outcome, not a single action. limits optionally sets a user budget " +
  "(maxCost in USD, maxTokens in total tokens); crossing it pauses the goal and " +
  "only a new objective with a new budget can re-arm it."

const UPDATE_DESCRIPTION =
  "Update the active goal for the current session. Use this to pause, resume, " +
  "complete, cancel, or change the objective of the current goal. When you believe " +
  'the goal has been achieved, call update_goal with status: "complete". ' +
  'status: "cancelled" is terminal; only get_goal still describes it. Pass ' +
  "recover with retry or abandon to resolve a continuation whose outcome nobody " +
  "confirmed. Raising a budget requires a new objective in the same call."

const GET_DESCRIPTION =
  "Read the active goal for the current session. Returns the current objective, " +
  "status, budget, breach and usage accounting. Returns null if no goal is active."

type CreateInput = { objective: string; session_id?: string; limits?: unknown }
type UpdateInput = {
  status?: GoalStatus
  objective?: string
  session_id?: string
  limits?: unknown
  recover?: RecoveryDisposition
}
type GetInput = { session_id?: string }

type GoalStatus = "active" | "paused" | "complete" | "cancelled"

const LIMIT_SCHEMA = {
  type: "object",
  description: "Optional user budget: maxCost (USD) and/or maxTokens (total tokens)",
  properties: {
    maxCost: { type: "number", exclusiveMinimum: 0 },
    maxTokens: { type: "number", exclusiveMinimum: 0 },
  },
  additionalProperties: false,
} as const

type ExecuteContext = { sessionID?: string }

function ownedSession(requested: string | undefined, context: ExecuteContext): string {
  const native = context?.sessionID
  if (typeof native !== "string" || !native.trim()) {
    throw new Error("no native session identity available")
  }
  if (requested !== undefined && requested !== native) {
    throw new Error("foreign-session access refused")
  }
  return native
}

function resolveOwner(requested: string | undefined, context: ExecuteContext) {
  try {
    return { sessionID: ownedSession(requested, context) }
  } catch (error) {
    return { output: `Error: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function render(goal: Goal | null): string {
  return JSON.stringify({ goal }, null, 2)
}

/**
 * Register the goal tools (gated by `goal_enabled`): create_goal, update_goal
 * and get_goal. State is one JSON file per session under `<stateHome>/goal/`,
 * so objectives persist across restarts and sessions never see each other's
 * goals.
 */
export async function mountGoal(
  ctx: Plugin.Context,
  stateHome: string,
  enabled: boolean,
  options?: { work?(sessionID: string): string | null },
): Promise<() => Promise<void>> {
  if (!enabled) return async () => {}
  const dir = goalDirectory(stateHome)
  const store = openGoalStore(dir)
  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omo", description: "OmO custom tools" })
    if (
      editor.get("omo_create_goal") ||
      editor.get("omo_update_goal") ||
      editor.get("omo_get_goal")
    ) {
      throw new Error("goal tool collision: omo_create_goal/omo_update_goal/omo_get_goal")
    }
    editor.add({
      name: "create_goal",
      description: CREATE_DESCRIPTION,
      options: { namespace: "omo", permission: "edit" },
      output: {},
      input: {
        type: "object",
        properties: {
          objective: { type: "string", description: "Concise outcome (required)" },
          limits: LIMIT_SCHEMA,
          session_id: { type: "string", description: "Session ID (default: current session)" },
        },
        required: ["objective"],
        additionalProperties: false,
      },
      async execute(input, context: ExecuteContext) {
        const args = input as CreateInput
        const owner = resolveOwner(args.session_id, context)
        if (owner.output !== undefined) return { output: owner.output }
        const sessionID = owner.sessionID
        return {
          output: render(store.set(sessionID, args.objective, validateLimits(args.limits))),
        }
      },
    })
    editor.add({
      name: "update_goal",
      description: UPDATE_DESCRIPTION,
      options: { namespace: "omo", permission: "edit" },
      output: {},
      input: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "paused", "complete", "cancelled"] },
          objective: { type: "string", description: "New objective text" },
          limits: LIMIT_SCHEMA,
          recover: {
            type: "string",
            enum: ["retry", "abandon"],
            description: "Resolve an unresolved continuation admission",
          },
          session_id: { type: "string", description: "Session ID (default: current session)" },
        },
        additionalProperties: false,
      },
      async execute(input, context: ExecuteContext) {
        const args = input as UpdateInput
        const owner = resolveOwner(args.session_id, context)
        if (owner.output !== undefined) return { output: owner.output }
        const sessionID = owner.sessionID
        if (args.recover !== undefined) store.recoverContinuation(sessionID, args.recover)
        if (args.limits !== undefined && args.objective === undefined)
          throw new Error("budget changes require a new objective")
        if (args.objective !== undefined)
          store.set(sessionID, args.objective, validateLimits(args.limits))
        if (args.status === "paused") store.pause(sessionID)
        else if (args.status === "active") store.resume(sessionID)
        else if (args.status === "complete") store.complete(sessionID)
        else if (args.status === "cancelled") store.cancel(sessionID)
        return { output: render(store.get(sessionID)) }
      },
    })
    editor.add({
      name: "get_goal",
      description: GET_DESCRIPTION,
      options: { namespace: "omo", permission: "read" },
      output: {},
      input: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID (default: current session)" },
        },
        additionalProperties: false,
      },
      async execute(input, context: ExecuteContext) {
        const args = input as GetInput
        const owner = resolveOwner(args.session_id, context)
        if (owner.output !== undefined) return { output: owner.output }
        const sessionID = owner.sessionID
        return { output: render(store.get(sessionID)) }
      },
    })
  })
  const stopContinuation = await mountGoalContinuation(ctx, store, options)
  return async () => {
    await stopContinuation()
    registration.dispose()
  }
}

/**
 * Mount the idle-continuation loop for an already-opened goal directory: idle
 * sessions with an active goal get the objective re-injected (bounded, see
 * `continuation.ts`) and usage reports are accrued. The event stream is
 * advisory; per-event failures never break the loop. The caller owns `store`.
 */
export async function mountGoalContinuation(
  ctx: Plugin.Context,
  store: ReturnType<typeof openGoalStore>,
  options?: {
    work?(sessionID: string): string | null
    // Test seam for the continuation trigger's cadence. Production keeps the
    // 15s interval that fires inside the live probes' 120s polls.
    quiet?: { intervalMs?: number }
  },
): Promise<() => Promise<void>> {
  const controller = new AbortController()
  const known = new Set<string>()
  const continuation = createGoalContinuation({
    store,
    prompt: (sessionID, text) =>
      ctx.session.prompt({ sessionID, text }, { signal: controller.signal }),
    work: options?.work,
  })
  const loop = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (controller.signal.aborted) break
      eventDiagnostics.recordSeen()
      eventDiagnostics.noteActivityFrom(event)
      // Remember every session the host mentions: the managed host never
      // reports an idle session, so the periodic trigger below re-checks these
      // instead of waiting for a signal that cannot arrive.
      const mentioned = (event as { data?: { sessionID?: unknown } }).data?.sessionID
      if (typeof mentioned === "string" && mentioned.trim()) known.add(mentioned)
      eventDiagnostics.recordShape(event.type)
      eventDiagnostics.recordStatusValue(event)
      try {
        // session.idle and session.usage.updated pass through unchanged. A
        // session.status idle event, if the host ever emits one, is folded into
        // the uniform session.idle shape so the continuation still sees exactly
        // one idle event kind. Live probes observed zero idle signals for
        // continued sessions, so this fold is defensive rather than a live path.
        const idle = idleSignalFrom(event)
        let forwarded: { type?: unknown; data?: unknown }
        if (idle) {
          forwarded =
            event.type === "session.idle"
              ? event
              : { type: "session.idle", data: { sessionID: idle.sessionID } }
          eventDiagnostics.recordIdle()
        } else if (event.type === "session.usage.updated") {
          forwarded = event
        } else {
          continue
        }
        const sessionID = idle
          ? idle.sessionID
          : (forwarded.data as { sessionID?: unknown }).sessionID
        if (typeof sessionID !== "string" || !sessionID.trim()) continue
        eventDiagnostics.recordWakeAttempt()
        const session = await ctx.session.get({ sessionID }, { signal: controller.signal })
        if (
          controller.signal.aborted ||
          session.id !== sessionID ||
          session.projectID !== ctx.location.project.id ||
          session.location.directory !== ctx.location.directory
        )
          continue
        const outcome = await continuation.handleEvent(forwarded)
        if (outcome.continued) eventDiagnostics.recordPrompt()
      } catch (error) {
        // Advisory stream: one bad event must not kill the loop, but the
        // swallowed failure is recorded first so the silence stays observable.
        eventDiagnostics.recordError(error)
      }
    }
  })()
  // Same architectural limit as the team mailbox wake: the host never delivers
  // an idle signal for continued sessions, so the continuation would never run.
  // Re-check the sessions the host mentioned on every interval instead; the
  // continuation itself still enforces "active goal only", per-session dedup
  // and its round budget.
  const stopQuiet = startQuietPrompter({
    signal: controller.signal,
    intervalMs: options?.quiet?.intervalMs ?? 15_000,
    shouldFire: () => known.size > 0,
    onQuiet: async () => {
      for (const sessionID of known) {
        if (controller.signal.aborted) return
        try {
          const session = await ctx.session.get({ sessionID }, { signal: controller.signal })
          if (
            controller.signal.aborted ||
            session.id !== sessionID ||
            session.projectID !== ctx.location.project.id ||
            session.location.directory !== ctx.location.directory
          )
            continue
          eventDiagnostics.recordWakeAttempt()
          const outcome = await continuation.handleEvent({
            type: "session.idle",
            data: { sessionID },
          })
          if (outcome.continued) eventDiagnostics.recordPrompt()
        } catch (error) {
          eventDiagnostics.recordError(error)
        }
      }
    },
  })
  return async () => {
    controller.abort()
    await stopQuiet()
    await loop.catch(() => {})
  }
}

const GOAL_USAGE =
  "Usage: omo-goal [show | set <objective> | pause | resume | complete | cancel | " +
  "recover <retry|abandon> | clear]"

/**
 * Build the `omo-goal` terminal command handler over the shared goal
 * directory under `stateHome` (`<stateHome>/goal/`): empty text shows the
 * current goal, otherwise the first word is the verb. Errors render as
 * `Error: ...` text instead of throwing so the terminal publish path always
 * has something to show.
 */
export function createGoalCommandService(stateHome: string) {
  const store = openGoalStore(goalDirectory(stateHome))
  const render = (value: unknown) => JSON.stringify(value, null, 2)
  return async ({ sessionID, text }: { sessionID: string; text: string }): Promise<string> => {
    const [verb, ...rest] = text.trim().split(/\s+/)
    try {
      switch ((verb ?? "").toLowerCase()) {
        case "":
          return render({ goal: store.get(sessionID) })
        case "show":
          return render({ goal: store.get(sessionID) })
        case "set":
          return render({ goal: store.set(sessionID, rest.join(" ")) })
        case "pause":
          return render({ goal: store.pause(sessionID) })
        case "resume":
          return render({ goal: store.resume(sessionID) })
        case "complete":
          return render({ goal: store.complete(sessionID) })
        case "cancel":
          return render({ goal: store.cancel(sessionID) })
        case "recover": {
          const disposition = (rest[0] ?? "").toLowerCase()
          if (disposition !== "retry" && disposition !== "abandon") {
            throw new Error("invalid-recovery-disposition")
          }
          return render({ goal: store.recoverContinuation(sessionID, disposition) })
        }
        case "clear":
          return render({ cleared: store.clear(sessionID) })
        default:
          return GOAL_USAGE
      }
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
