import type { Plugin } from "@opencode/plugin"
import { type BoulderOptions, type BoulderStore, openBoulderStore, type WorkStatus } from "./store"

const UPDATE_ACTIONS = [
  "start",
  "pause",
  "resume",
  "complete",
  "abandon",
  "offer",
  "claim",
  "recover",
  "sweep",
] as const

type UpdateAction = (typeof UPDATE_ACTIONS)[number]

/**
 * Mount the session-local work tools. A caller that already owns the state
 * home's boulder store (see `openBoulderContext`) passes it in, so the goal
 * continuation and the boulder tools always observe the same records;
 * otherwise one is opened from the state home and `options` applies —
 * including `projectRoot`, the project anchor for plan documents. Session
 * records always stay in the state home.
 */
export async function mountBoulder(
  ctx: Plugin.Context,
  stateHome: string,
  enabled: boolean,
  store?: BoulderStore,
  options?: BoulderOptions,
): Promise<() => Promise<void>> {
  if (!enabled) return async () => {}
  store ??= openBoulderStore(stateHome, options)
  const controller = new AbortController()
  /**
   * A finished compaction proves the session is still alive, so its own live
   * work gets a liveness refresh instead of drifting toward a stale flag. This
   * never clears `stale`: only an explicit sweep plus recover can do that.
   */
  const liveness = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (controller.signal.aborted) break
      try {
        if (event.type !== "session.compaction.ended") continue
        const sessionID = (event.data as { sessionID?: unknown }).sessionID
        if (typeof sessionID !== "string" || !sessionID.trim()) continue
        const session = await ctx.session.get({ sessionID }, { signal: controller.signal })
        if (
          controller.signal.aborted ||
          session.id !== sessionID ||
          session.projectID !== ctx.location.project.id ||
          session.location.directory !== ctx.location.directory
        )
          continue
        store.touch(sessionID)
      } catch {
        // Advisory stream: a failed liveness refresh never breaks the loop.
      }
    }
  })()
  async function owner(context: { sessionID?: string }): Promise<string> {
    const sessionID = context?.sessionID
    if (typeof sessionID !== "string" || !sessionID.trim())
      throw new Error("native-session-required")
    const session = await ctx.session.get({ sessionID })
    if (
      session.id !== sessionID ||
      session.projectID !== ctx.location.project.id ||
      session.location.directory !== ctx.location.directory
    )
      throw new Error("foreign-session")
    return sessionID
  }
  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omo", description: "OmO custom tools" })
    if (editor.get("omo_boulder_state") || editor.get("omo_boulder_update"))
      throw new Error("boulder tool collision")
    editor.add({
      name: "boulder_state",
      description:
        "Read this session's persisted works: the implicit work, every work, plan checklist progress and pending handoff invitations from other sessions. Invitations are not work until claimed.",
      options: { namespace: "omo", permission: "read" },
      output: {},
      input: {
        type: "object",
        properties: { workID: { type: "string" } },
        additionalProperties: false,
      },
      async execute(input, context: { sessionID?: string }) {
        const sessionID = await owner(context)
        const workID = (input as { workID?: string } | undefined)?.workID
        const payload = JSON.stringify({
          work: store.get(sessionID, workID),
          works: store.list(sessionID),
          invitations: store.invitations(sessionID),
          progress: store.progress(sessionID, workID),
        })
        return { output: payload, content: payload }
      },
    })
    editor.add({
      name: "boulder_update",
      description:
        "Manage this session's work. start requires a plan inside the project and each start adds another work; " +
        "pause/resume/complete/abandon act on the implicit unfinished work unless workID is given. " +
        "offer hands one work to another session (the other session must claim it), claim accepts an invitation " +
        "addressed to this session, sweep flags work untouched beyond the stale window without changing its status, " +
        "and recover resumes or abandons a flagged work. Recovering is always explicit.",
      options: { namespace: "omo", permission: "edit" },
      output: {},
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...UPDATE_ACTIONS] },
          plan: { type: "string" },
          workID: { type: "string" },
          toSessionID: { type: "string" },
          disposition: { type: "string", enum: ["resume", "abandon"] },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async execute(input, context: { sessionID?: string }) {
        const sessionID = await owner(context)
        const args = input as {
          action: UpdateAction
          plan?: string
          workID?: string
          toSessionID?: string
          disposition?: "resume" | "abandon"
        }
        switch (args.action) {
          case "start": {
            if (!args.plan) throw new Error("plan-required")
            const payload = JSON.stringify({ work: store.start(sessionID, args.plan) })
            return { output: payload, content: payload }
          }
          case "offer": {
            if (typeof args.workID !== "string" || !args.workID.trim())
              throw new Error("work-id-required")
            if (typeof args.toSessionID !== "string" || !args.toSessionID.trim())
              throw new Error("handoff-target-required")
            const payload = JSON.stringify({
              invitation: store.offer(sessionID, args.workID, args.toSessionID),
            })
            return { output: payload, content: payload }
          }
          case "claim": {
            if (typeof args.workID !== "string" || !args.workID.trim())
              throw new Error("work-id-required")
            const payload = JSON.stringify({ work: store.claim(sessionID, args.workID) })
            return { output: payload, content: payload }
          }
          case "sweep": {
            const payload = JSON.stringify({ flagged: store.sweep(sessionID) })
            return { output: payload, content: payload }
          }
          case "recover": {
            if (typeof args.workID !== "string" || !args.workID.trim())
              throw new Error("work-id-required")
            if (!args.disposition) throw new Error("recovery-disposition-required")
            const payload = JSON.stringify({
              work: store.recover(sessionID, args.workID, args.disposition),
            })
            return { output: payload, content: payload }
          }
          default: {
            const transitions: Record<string, WorkStatus> = {
              pause: "paused",
              resume: "active",
              complete: "completed",
              abandon: "abandoned",
            }
            const status = transitions[args.action]
            if (!status) throw new Error("invalid-work-action")
            const payload = JSON.stringify({
              work: store.transition(sessionID, status, args.workID),
            })
            return { output: payload, content: payload }
          }
        }
      },
    })
  })
  return async () => {
    controller.abort()
    await liveness.catch(() => {})
    registration.dispose()
    store.close()
  }
}
