/**
 * Team-mode status block.
 *
 * The V2 public SDK has no message-transform hook, so the block is injected
 * from the session context hook, which owns the mutable `messages` array. The
 * marker is a self-closing tag with no children: the upstream variant nests
 * upstream knowledge this build does not parse, so claiming it would be false.
 */
const MARKER = '<team_mode_status enabled="true" />'
const KEYWORDS = /\bteams?\b|\bworkers?\b|\bdelegat\w*|\bsubagents?\b/i

export function statusTrigger(text: string): boolean {
  if (typeof text !== "string" || !text) return false
  return KEYWORDS.test(text.toLowerCase())
}

export function statusBlockText(): string {
  return MARKER
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Concatenated text of a content part array. The V2 model-request shape is
 * `{ id?, role, content: [{ type: "text", text }] }` — there are no `parts`, no
 * `info.role` and no `synthetic` flag, so our marker text is what identifies an
 * injected message.
 */
function textOf(value: unknown): string {
  if (!record(value) || !Array.isArray(value.content)) return ""
  return value.content
    .filter((part) => record(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => (part as { text: string }).text)
    .join("\n")
    .trim()
}

/** Text of a real user message: user role with a nonblank textual part.
 * Non-text parts are ignored rather than stringified. Every message this plugin
 * injects is a `<team_…>` marker block, so such text is not a real request —
 * otherwise a mailbox block would look like a team request and earn a status
 * notice on every model request. */
function realUserText(value: unknown): string | null {
  if (!record(value) || value.role !== "user") return null
  const text = textOf(value)
  if (!text || text.startsWith("<team_")) return null
  return text
}

/** True when a synthetic part already carries the marker. */
export function hasStatusBlock(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  for (const message of messages) if (textOf(message).includes(MARKER)) return true
  return false
}

/** Injects the block once, before the matching real user message. Returns true
 * only when a synthetic message was added. Never throws. */
export function injectStatusBlock(input: { messages: unknown }): boolean {
  try {
    const messages = input?.messages
    if (!Array.isArray(messages) || messages.length === 0) return false
    if (hasStatusBlock(messages)) return false
    let index = -1
    for (let position = messages.length - 1; position >= 0; position--)
      if (realUserText(messages[position]) !== null) {
        index = position
        break
      }
    if (index < 0) return false
    if (!statusTrigger(realUserText(messages[index]) as string)) return false
    messages.splice(index, 0, {
      role: "user",
      content: [{ type: "text", text: MARKER }],
    })
    return true
  } catch {
    return false
  }
}
