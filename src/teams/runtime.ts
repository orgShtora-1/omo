import { type Team, TeamError } from "./model"

export interface TeamMessage {
  id: string
  teamID: string
  senderID: string
  body: string
  createdAt: number
  acknowledgedAt: number | null
}

/**
 * Refuses cross-team or non-participant team work by throwing.
 *
 * The installed promise-based hook surface
 * (`@opencode/plugin`'s `registration.d.ts`) types callbacks as
 * `(input) => Promise<void> | void` and exposes no documented denial channel, so
 * whether a thrown error blocks the call is NOT verified here: the `omo_team`
 * body re-checks membership for every action and remains authoritative. This
 * hook is defence in depth and an early, cheaper error, nothing more. Only
 * `omo_team` is gated; unrelated tools pass untouched. The caller is the native
 * session that invoked the tool, never a value taken from the input.
 */
export function gateTeamTool(input: {
  tool: string
  input: unknown
  sessionID: string
  teams: readonly Team[]
  leaderSessionID: string
}): void {
  if (input.tool !== "omo_team") return
  const raw = input.input
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new TeamError("invalid-input", "team tool input")
  const args = raw as { action?: unknown; teamID?: unknown; memberID?: unknown }
  if (typeof input.sessionID !== "string" || !input.sessionID.trim())
    throw new TeamError("invalid-input", "sessionID")
  const action = args.action
  if (typeof action !== "string" || !action.trim()) throw new TeamError("invalid-input", "action")
  const participates = input.teams.some(
    (team) =>
      team.leaderID === input.sessionID ||
      team.members.some((entry) => entry.id === input.sessionID),
  )
  if (action === "create") {
    if (participates) throw new TeamError("already-participates", "team")
    return
  }
  if (action === "list" || action === "status") return
  if (typeof args.teamID !== "string" || !args.teamID.trim())
    throw new TeamError("team-required", action)
  const target = input.teams.find((team) => team.id === args.teamID)
  if (!target) throw new TeamError("unknown-team", args.teamID)
  if (action === "delete" || action === "shutdown_request") {
    if (target.leaderID !== input.sessionID) throw new TeamError("lead-only", action)
    return
  }
  if (action === "shutdown_approve" || action === "shutdown_reject") {
    const subject = typeof args.memberID === "string" ? args.memberID : ""
    const member = target.members.find((entry) => entry.id === input.sessionID)
    const leader = target.leaderID === input.sessionID
    if (!leader && (!member || (!member.active && subject !== member.id)))
      throw new TeamError("lead-or-member", action)
    return
  }
  const member = target.members.find((entry) => entry.id === input.sessionID)
  if (target.leaderID !== input.sessionID && !member)
    throw new TeamError("not-a-participant", target.id)
}

/** Renders pending mailbox text; `null` when nothing is waiting. */
export function buildMailboxBlock(
  teams: readonly Team[],
  messages: readonly TeamMessage[],
): string | null {
  const known = new Set(teams.map((team) => team.id))
  const pending = messages.filter(
    (message) =>
      known.has(message.teamID) &&
      message.acknowledgedAt === null &&
      typeof message.id === "string" &&
      message.id.trim() &&
      typeof message.senderID === "string" &&
      message.senderID.trim() &&
      typeof message.body === "string" &&
      message.body.trim(),
  )
  if (!pending.length) return null
  const byTeam = new Map<string, TeamMessage[]>()
  for (const message of pending) {
    const list = byTeam.get(message.teamID) ?? []
    list.push(message)
    byTeam.set(message.teamID, list)
  }
  return [...byTeam.entries()]
    .map(([teamID, items]) => {
      const lines = items.map(
        (message) => `- ${message.id} from ${message.senderID}: ${message.body}`,
      )
      return `<team_mailbox team="${teamID}" pending="${items.length}">\n${lines.join("\n")}\n</team_mailbox>`
    })
    .join("\n")
}

/**
 * Appends one synthetic user message per turn marker. Returns whether a message
 * was added; blank text is never injected.
 *
 * The host model-request message is `{ id?, role, content: [{ type: "text",
 * text }] }` (from `@opencode/ai`'s `Message`), so the injected message uses
 * exactly that shape and its own marker text — there is no `synthetic` flag and
 * no `parts` array to rely on.
 */
export function injectMailbox(messages: unknown[], text: string, marker: string): boolean {
  if (typeof text !== "string" || !text.trim()) return false
  if (typeof marker !== "string" || !marker.trim()) return false
  const identity = `omo-team-${marker}`
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue
    if ((message as { id?: unknown }).id === identity) return false
    if (!Array.isArray((message as { content?: unknown }).content)) continue
    // Text carrying our own marker means this turn was already injected.
    if (messageText(message).includes(marker)) return false
  }
  messages.push({
    id: identity,
    role: "user",
    content: [{ type: "text", text }],
  })
  return true
}

/** Text of a host message's text parts; "" for anything unreadable. */
function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return ""
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
        ? (part as { text?: unknown }).text
        : "",
    )
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join(" ")
}

/**
 * A marker that stays stable for the same real conversation. Messages this
 * plugin injected are excluded from the count, so a second model request for
 * the same turn yields the same marker and cannot duplicate the block.
 */
export function turnMarker(sessionID: string, messages: unknown[]): string {
  if (typeof sessionID !== "string" || !sessionID.trim()) return ""
  let real = 0
  for (const message of messages) {
    if (typeof message === "object" && message !== null) {
      const id = (message as { id?: unknown }).id
      if (typeof id === "string" && id.startsWith("omo-team-")) continue
      if (
        messageText(message).startsWith("<team_mailbox") ||
        messageText(message).startsWith("<team_mode_status")
      )
        continue
    }
    real += 1
  }
  return `${sessionID}#${real}`
}

export interface WakeState {
  hinted: Set<string>
  wakes: number
  budgetUsed?: number
}

/**
 * Decides whether an idle session should be woken by its mailbox. Identical
 * mail is never hinted twice, an unread lookup failure never wakes, and the
 * per-state wake budget bounds repeated prompting.
 */
export function decideWake(
  state: WakeState,
  sessionID: string,
  messages: readonly TeamMessage[],
  options: { maxWakes?: number; pending?: () => boolean | undefined } = {},
): { wake: boolean; pending: readonly TeamMessage[] } {
  const pending = messages.filter((message) => message.acknowledgedAt === null)
  if (typeof sessionID !== "string" || !sessionID.trim())
    throw new TeamError("invalid-input", "sessionID")
  const maxWakes = options.maxWakes ?? 3
  if (!Number.isSafeInteger(maxWakes) || maxWakes < 1)
    throw new TeamError("invalid-input", "maxWakes")
  if (!pending.length || state.wakes >= maxWakes) return { wake: false, pending }
  // An unread lookup that did not confirm new mail never triggers a wake.
  if (options.pending && options.pending() !== true) return { wake: false, pending }
  const unseen = pending.filter((message) => !state.hinted.has(message.id))
  if (!unseen.length) return { wake: false, pending }
  state.hinted = new Set([...state.hinted, ...unseen.map((message) => message.id)])
  state.wakes += 1
  return { wake: true, pending: unseen }
}
