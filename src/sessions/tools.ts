import type { Plugin } from "@opencode/plugin"
import { curateSessionInfo, summarizeSessionMessages } from "./curate"

const DESCRIPTION =
  "Read-only session introspection over the caller's own ancestor chain. " +
  "Actions: info returns a curated session identity snapshot; context returns " +
  "newest message previews. The target defaults to the calling session; an " +
  "explicit sessionID outside the caller chain is rejected with foreign-session. " +
  "There is no global listing."

interface SessionLink {
  id: string
  projectID: string
  parentID?: string
}

type SessionReader = (input: { sessionID: string }) => Promise<SessionLink>

function narrow(record: { id: string; projectID: string; parentID?: string }): SessionLink {
  return {
    id: record.id,
    projectID: record.projectID,
    ...(record.parentID === undefined ? {} : { parentID: record.parentID }),
  }
}

/** Resolve the requested target: self by default, otherwise a verified ancestor. Unknown targets surface the host error; anything outside the chain is foreign. */
async function resolveTarget(
  get: SessionReader,
  selfID: string,
  requested: string | undefined,
): Promise<SessionLink> {
  const self = narrow(await get({ sessionID: selfID }))
  if (requested === undefined || requested === selfID) return self
  const candidate = narrow(await get({ sessionID: requested }))
  if (candidate.projectID !== self.projectID) throw new Error("foreign-session")
  let ancestorID = self.parentID
  const seen = new Set([self.id])
  for (let depth = 0; depth < 64 && ancestorID !== undefined; depth++) {
    if (ancestorID === candidate.id) return candidate
    if (seen.has(ancestorID)) break
    seen.add(ancestorID)
    try {
      ancestorID = narrow(await get({ sessionID: ancestorID })).parentID
    } catch {
      break
    }
  }
  throw new Error("foreign-session")
}

/** Register the read-only session introspection tool (no flag: strictly read-only, like team reads). */
export async function mountSessions(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omo", description: "OmO custom tools" })
    if (editor.get("omo_session")) throw new Error("session tool collision: omo_session")
    editor.add({
      name: "session",
      description: DESCRIPTION,
      options: { namespace: "omo", permission: "read" },
      output: {},
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["info", "context"] },
          sessionID: { type: "string", description: "Ancestor session; defaults to the caller" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = raw as Record<string, unknown>
        const requested = input.sessionID
        if (requested !== undefined && (typeof requested !== "string" || !requested.trim()))
          throw new Error("sessionID must be a non-empty string")
        const get = ctx.session.get as unknown as SessionReader
        const contextOf = ctx.session.context as unknown as (input: {
          sessionID: string
        }) => Promise<unknown>
        const target = await resolveTarget(get, context.sessionID, requested)
        if (input.action === "info") {
          const output = curateSessionInfo(
            (await get({ sessionID: target.id })) as unknown as Parameters<
              typeof curateSessionInfo
            >[0],
          )
          return { output, content: JSON.stringify(output) }
        }
        if (input.action === "context") {
          const messages = await contextOf({ sessionID: target.id })
          if (!Array.isArray(messages)) throw new Error("session context unavailable")
          const output = summarizeSessionMessages(messages)
          return { output, content: JSON.stringify(output) }
        }
        throw new Error("unknown session action")
      },
    })
  })
  return async () => {
    await registration.dispose()
  }
}
