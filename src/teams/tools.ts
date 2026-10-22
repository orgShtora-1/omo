import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { teamIneligibleAgentIDs } from "../agents/prompts"
import { eventDiagnostics } from "../events/diagnostics"
import { idleSignalFrom } from "../events/idle"
import { startQuietPrompter } from "../events/quiet"
import { openTeamStore } from "./claims"
import type { TeamInput } from "./model"
import {
  buildMailboxBlock,
  decideWake,
  gateTeamTool,
  injectMailbox,
  turnMarker,
  type WakeState,
} from "./runtime"
import { injectStatusBlock } from "./status"

/**
 * Caller identity comes from the native tool context, never from model input.
 * `runtime: false` mounts only the tool. The pre-tool gate, mailbox injection
 * and idle wake are then never registered, so callers that opt out must not
 * expect them; the tool body itself stays authoritative for every action.
 * Durable team state (teams.sqlite) lives under `stateHome`, the caller-supplied
 * per-project state directory.
 */
export async function mountTeams(
  ctx: Plugin.Context,
  stateHome: string,
  options: {
    runtime?: boolean
    // Test seam for the quiet-window prompter's timing. Production keeps the
    // 60s window that fires inside the live probes' 120s polls.
    quiet?: { intervalMs?: number; quietMs?: number; now?: () => number }
  } = {},
): Promise<() => Promise<void>> {
  const stores = new Map<string, ReturnType<typeof openTeamStore>>()
  const identity = async (sessionID: string) => {
    const session = await ctx.session.get({ sessionID })
    if (session.projectID !== ctx.location.project.id) throw new Error("foreign-project")
    const parentID = session.parentID ?? sessionID
    if (session.parentID) {
      const parent = await ctx.session.get({ sessionID: parentID })
      if (parent.projectID !== session.projectID) throw new Error("foreign-parent")
    }
    let store = stores.get(parentID)
    if (!store) {
      store = openTeamStore(join(stateHome, "teams.sqlite"), {
        projectID: session.projectID,
        locationID: ctx.location.directory,
        parentSessionID: parentID,
      })
      stores.set(parentID, store)
    }
    return { store, parentID }
  }
  const registration = await ctx.tool.transform((editor) => {
    if (editor.get("omo_team")) throw new Error("tool collision: omo_team")
    editor.add({
      name: "team",
      description:
        "Durable team tasks and mailbox. Native session identity determines member and leader authority; claims and acknowledgements survive restart. Actions cover team status/list, task CRUD, claims, mailbox, team deletion and the shutdown request/approve/reject lifecycle.",
      // Intentional legacy visibility key: subagent * deny must not hide a non-nesting
      // child's mailbox/claims. Delegation is still checked by authorizeParent,
      // including legacy task rules; broad/task denies still apply. See ADR 0012.
      options: { namespace: "omo", permission: "task" },
      // INTENTIONAL legacy gate (see docs/adr/0012-team-task-permission-gate.md):
      // the canonical V2 delegation action is "subagent", but this mailbox tool
      // keeps permission "task" so a project rule like `subagent * deny` does
      // not hide team coordination from non-nesting children. Delegation itself
      // is still gated separately by authorizeParent, which treats task rules
      // as subagent-delegation rules (fail-closed, ask never auto-granted).
      output: {},
      input: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: {
            enum: [
              "create",
              "status",
              "list",
              "task_create",
              "task_list",
              "task_get",
              "task_update",
              "claim",
              "complete",
              "remove",
              "release",
              "send",
              "read",
              "ack",
              "delete",
              "shutdown_request",
              "shutdown_approve",
              "shutdown_reject",
            ],
          },
          teamID: { type: "string", minLength: 1 },
          taskID: { type: "string" },
          dependencies: { type: "array", items: { type: "string" } },
          memberID: { type: "string" },
          claimID: { type: "string" },
          members: { type: "array", items: { type: "string" } },
          tasks: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "dependencies"],
              properties: {
                id: { type: "string" },
                dependencies: { type: "array", items: { type: "string" } },
              },
              additionalProperties: false,
            },
          },
          evidence: { type: "array", items: { type: "string" } },
          confirmedStopped: { type: "boolean" },
          recipientID: { type: "string" },
          dedupKey: { type: "string" },
          body: { type: "string" },
          messageID: { type: "string" },
        },
      },
      async execute(raw, context) {
        const input = raw as Record<string, unknown>
        const { store, parentID } = await identity(context.sessionID)
        const required = (key: string): string => {
          const value = input[key]
          if (typeof value !== "string" || !value.trim()) throw new Error(`${key} required`)
          return value
        }
        let output: unknown
        if (input.action === "list") {
          output = store.listTeams(context.sessionID)
        } else {
          const teamID = required("teamID")
          switch (input.action) {
            case "create": {
              if (context.sessionID !== parentID) throw new Error("leader-required")
              if (!Array.isArray(input.members)) throw new Error("members required")
              // Consultation agents can neither write nor delegate, so a team
              // claim routed to them would stall forever (upstream parity).
              const consultationAgent = async (sessionID: string) => {
                const record = (await ctx.session.get({ sessionID })) as { agent?: unknown }
                if (typeof record.agent === "string" && teamIneligibleAgentIDs.has(record.agent))
                  throw new Error(`consult-member: ${record.agent}`)
              }
              await consultationAgent(context.sessionID)
              for (const memberID of input.members) {
                const member = await ctx.session.get({ sessionID: memberID })
                if (
                  member.projectID !== ctx.location.project.id ||
                  (memberID !== parentID && member.parentID !== parentID)
                )
                  throw new Error("foreign-member")
                await consultationAgent(memberID)
              }
              output = store.createTeam({
                id: teamID,
                leaderID: parentID,
                members: input.members,
                tasks: input.tasks,
              } as TeamInput)
              break
            }
            case "status":
              output = store.loadTeam(teamID)
              break
            case "task_create": {
              const dependencies = input.dependencies
              if (dependencies !== undefined && !Array.isArray(dependencies))
                throw new Error("dependencies must be an array")
              output = store.addTask(
                teamID,
                required("taskID"),
                dependencies === undefined ? [] : dependencies,
                context.sessionID,
              )
              break
            }
            case "task_list":
              output = store.listTasks(teamID, context.sessionID)
              break
            case "task_get":
              output = store.getTask(teamID, required("taskID"), context.sessionID)
              break
            case "task_update": {
              const dependencies = input.dependencies
              if (!Array.isArray(dependencies)) throw new Error("dependencies required")
              output = store.updateTask(teamID, required("taskID"), dependencies, context.sessionID)
              break
            }
            case "claim":
              output = store.claimTask(teamID, required("taskID"), context.sessionID)
              break
            case "complete": {
              const evidence = input.evidence
              if (!Array.isArray(evidence)) throw new Error("evidence required")
              output = store.completeTask(
                teamID,
                required("taskID"),
                required("claimID"),
                context.sessionID,
                evidence,
              )
              break
            }
            case "remove":
              output = store.removeMember(teamID, required("memberID"), context.sessionID)
              break
            case "release":
              output = store.releaseClaim(
                teamID,
                required("taskID"),
                required("claimID"),
                context.sessionID,
                input.confirmedStopped === true,
              )
              break
            case "send": {
              const taskID = input.taskID
              if (taskID !== undefined && typeof taskID !== "string")
                throw new Error("taskID must be a string")
              output = store.sendMessage({
                teamID,
                senderID: context.sessionID,
                recipientID: required("recipientID"),
                dedupKey: required("dedupKey"),
                body: required("body"),
                ...(taskID === undefined ? {} : { taskID }),
              })
              break
            }
            case "read":
              output = store.readMessages(teamID, context.sessionID)
              break
            case "ack":
              output = store.ackMessage(teamID, required("messageID"), context.sessionID)
              break
            case "delete":
              output = store.deleteTeam(teamID, context.sessionID)
              break
            case "shutdown_request":
              output = store.requestShutdown(teamID, context.sessionID)
              break
            case "shutdown_approve":
              output = store.approveShutdown(teamID, context.sessionID)
              break
            case "shutdown_reject":
              output = store.rejectShutdown(teamID, context.sessionID)
              break
            default:
              throw new Error("unknown team action")
          }
        }
        output = await output
        if (
          input.action === "status" &&
          output &&
          !(output as { members: Array<{ id: string; active: boolean }> }).members.some(
            (member) => member.id === context.sessionID && member.active,
          )
        )
          throw new Error("member-inactive")
        return { output, content: JSON.stringify(output ?? { ok: true }) }
      },
    })
  })
  let disposed = false
  if (options.runtime === false) {
    return async () => {
      if (disposed) return
      disposed = true
      try {
        await registration.dispose()
      } finally {
        for (const store of stores.values()) store.close()
        // A continued session may still reach this mount after dispose, so drop
        // the closed handles and let the next call reopen the store lazily.
        stores.clear()
      }
    }
  }
  const controller = new AbortController()
  const { signal } = controller
  // Pending mailbox for one session, used both for context injection and idle wake.
  const unread = async (sessionID: string) => {
    const { store } = await identity(sessionID)
    const teams = await store.listTeams(sessionID)
    const messages = (
      await Promise.all(teams.map(async (team) => store.readMessages(team.id, sessionID)))
    ).flat()
    return { teams, messages }
  }
  const mailbox = await ctx.session.hook("context", async (input) => {
    if (signal.aborted) return
    try {
      const sessionID = input.sessionID
      if (typeof sessionID !== "string" || !sessionID.trim()) return
      const { teams, messages } = await unread(sessionID)
      if (signal.aborted) return
      const text = buildMailboxBlock(teams, messages)
      // The marker counts only real messages, so injection cannot change the
      // marker it is derived from and duplicate the block on the next request.
      if (text) injectMailbox(input.messages, text, turnMarker(sessionID, input.messages ?? []))
      // Status notice is independent of unread mail: an empty mailbox still
      // tells the model that team mode exists.
      injectStatusBlock(input as { messages: unknown })
    } catch {
      // Injection is best effort and must never break a model request.
    }
  })
  const gate = await ctx.tool.hook("execute.before", async (event) => {
    if (signal.aborted) return
    const sessionID = event.sessionID
    if (typeof sessionID !== "string" || !sessionID.trim()) return
    // A failed check throws instead of silently allowing. Whether the host
    // turns that into a denial is not documented for this hook surface, so the
    // `omo_team` body stays authoritative; this only fails early and loudly.
    const { store, parentID } = await identity(sessionID)
    gateTeamTool({
      tool: event.tool,
      input: event.input,
      sessionID,
      teams: await store.listTeams(sessionID),
      leaderSessionID: parentID,
    })
  })
  const wakes = new Map<string, WakeState>()
  // Shared idle/quiet wake body: the quiet-window prompter calls this on the
  // same path as a host idle signal, so decideWake's one-shot hints and wake
  // budget apply to both triggers.
  const wakeSession = async (sessionID: string): Promise<void> => {
    try {
      eventDiagnostics.recordWakeAttempt()
      const { teams, messages } = await unread(sessionID)
      if (signal.aborted) return
      const state = wakes.get(sessionID) ?? { hinted: new Set<string>(), wakes: 0 }
      const decision = decideWake(state, sessionID, messages)
      wakes.set(sessionID, state)
      const text = buildMailboxBlock(teams, decision.pending)
      if (!decision.wake || !text) return
      await ctx.session.prompt({ sessionID, text }, { signal })
      eventDiagnostics.recordPrompt()
    } catch (error) {
      // A failed wake must never break the event stream, but it must stop
      // being invisible: record the swallowed error before moving on.
      eventDiagnostics.recordError(error)
    }
  }
  const events = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal })) {
        if (signal.aborted) return
        eventDiagnostics.recordSeen()
        eventDiagnostics.noteActivityFrom(event)
        eventDiagnostics.recordShape(event.type)
        eventDiagnostics.recordStatusValue(event)
        // Both idle shapes mean the same thing here. Live probes showed the
        // host delivers neither reliably for continued sessions, so the
        // quiet-window prompter below reuses wakeSession on the same path.
        const idle = idleSignalFrom(event)
        if (!idle) continue
        eventDiagnostics.recordIdle()
        await wakeSession(idle.sessionID)
      }
    } catch {
      // Subscription failures are not fatal for the mount.
    }
  })()
  // The managed host never delivers idle for continued or child sessions
  // (proven live: zero idle signals across thousands of events), so a quiet
  // window over the same event stream retriggers wakeSession with the same
  // one-shot guards. Sixty seconds fires inside the tests' 120s polls.
  const stopQuiet = startQuietPrompter({
    signal,
    intervalMs: options.quiet?.intervalMs ?? 15_000,
    quietMs: options.quiet?.quietMs ?? 60_000,
    now: options.quiet?.now,
    // The managed host never reports an idle session and its event stream
    // never goes silent (measured: activity always within milliseconds of
    // every tick), so a silence gate can never open. Fire while this mount
    // still has sessions to check; wakeSession's one-shot hints and wake
    // budget keep the proactive prompt from repeating.
    shouldFire: () => stores.size > 0,
    onTick: () => eventDiagnostics.recordQuietTick(),
    onQuiet: async () => {
      for (const parentID of stores.keys()) {
        if (signal.aborted) return
        await wakeSession(parentID)
      }
    },
  })
  return async () => {
    if (disposed) return
    disposed = true
    controller.abort()
    try {
      await stopQuiet()
      await registration.dispose()
      await mailbox.dispose()
      await gate.dispose()
      await events
    } finally {
      for (const store of stores.values()) store.close()
      // A continued session may still reach this mount after dispose, so drop
      // the closed handles and let the next call reopen the store lazily.
      stores.clear()
    }
  }
}
