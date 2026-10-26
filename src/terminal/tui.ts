import type { Plugin } from "@opencode/plugin/tui"
import { profiles } from "../agents/prompts"

const builtinAgentIDs = new Set(profiles.map((profile) => profile.id))

/** Native dialogs avoid a second UI runtime and keep server and CLI options separate. */
export function mountTerminalUi(ctx: Plugin.Context): () => void {
  let disposed = false
  const currentSession = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  const dispatch = async (name: string, text = "") => {
    const sessionID = currentSession()
    if (!sessionID || disposed) return
    await ctx.client.session.command({ sessionID, name, text })
  }
  const planAction = async (name: "omo-resume" | "omo-cancel") => {
    const text = await ctx.ui.dialog.prompt({
      title: name === "omo-cancel" ? "Cancel OMO plan" : "Resume OMO plan",
      placeholder: "Plan ID",
    })
    if (text !== undefined && !disposed) await dispatch(name, text)
  }
  const open = async () => {
    const sessionID = currentSession()
    if (!sessionID || disposed) return
    await ctx.data.session.sync(sessionID)
    if (disposed) return
    const family = new Set(ctx.data.session.family(sessionID))
    family.add(sessionID)
    const sessions = ctx.data.session.list().filter(
      (session) =>
        family.has(session.id) &&
        (session.id === sessionID ||
          (session.agent !== undefined && builtinAgentIDs.has(session.agent)) ||
          // Historical sessions keep their original agent IDs after migration.
          session.agent?.startsWith("omo-")),
    )
    const selected = await ctx.ui.dialog.select({
      title: "OMO task sessions",
      options: [
        { title: "Plan status", value: "action:status", category: "Actions" },
        { title: "Resume plan", value: "action:resume", category: "Actions" },
        { title: "Cancel plan", value: "action:cancel", category: "Actions" },
        ...sessions.map((session) => ({
          value: session.id,
          title: session.title ?? session.id,
          category: "Sessions",
          description: `${ctx.data.session.status(session.id)} · ${session.agent ?? "parent"} · ${session.model ? `${session.model.providerID}/${session.model.id}` : "host model"}${session.outcome ? ` · ${session.outcome}` : ""}`,
        })),
      ],
    })
    if (!selected || disposed) return
    if (selected === "action:status") await dispatch("omo-status")
    else if (selected === "action:resume") await planAction("omo-resume")
    else if (selected === "action:cancel") await planAction("omo-cancel")
    else ctx.ui.router.navigate({ type: "session", sessionID: selected })
  }

  // keymap layers are automatically owned/removed by the SDK's plugin lifecycle.
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "shtora.omo.tasks",
        title: "OMO task sessions",
        group: "OMO",
        palette: true,
        slash: { name: "omo-tasks" },
        enabled: () => !!currentSession() && !disposed,
        run: open,
      },
    ],
  }))
  return () => {
    disposed = true
  }
}

export default {
  id: "shtora.omo.cli",
  setup(ctx) {
    if (ctx.options.enabled === false) return
    return mountTerminalUi(ctx)
  },
} satisfies Plugin.Definition
