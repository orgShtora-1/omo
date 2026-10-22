import { truncateText } from "../runtime/tool-guards"

/** Newest session messages retained per context call. */
export const MAX_SESSION_MESSAGES = 50
/** Characters kept per message preview before truncation. */
export const MESSAGE_PREVIEW_LIMIT = 500

export interface SessionInfoInput {
  id: string
  projectID: string
  parentID?: string
  agent?: string
  model?: unknown
  cost?: unknown
  tokens?: unknown
  outcome?: string
  title?: string
  time?: unknown
  // Real SDK records carry host-only fields (metadata, permissions, location,
  // revert, ...). They typecheck here and are dropped by curateSessionInfo.
  [key: string]: unknown
}

export interface SessionInfoView {
  id: string
  projectID: string
  parentID?: string
  agent?: string
  model?: unknown
  cost?: unknown
  tokens?: unknown
  outcome?: string
  title?: string
  time?: unknown
}

export interface SessionMessageSummary {
  type: string
  preview: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Curated identity snapshot: host internals (metadata, permissions, location, revert) never leave the host. */
export function curateSessionInfo(info: SessionInfoInput): SessionInfoView {
  const view: SessionInfoView = { id: info.id, projectID: info.projectID }
  if (info.parentID !== undefined) view.parentID = info.parentID
  if (info.agent !== undefined) view.agent = info.agent
  if (info.model !== undefined) view.model = info.model
  if (info.cost !== undefined) view.cost = info.cost
  if (info.tokens !== undefined) view.tokens = info.tokens
  if (info.outcome !== undefined) view.outcome = info.outcome
  if (info.title !== undefined) view.title = info.title
  if (info.time !== undefined) view.time = info.time
  return view
}

function extractPreview(message: Record<string, unknown>): string {
  if (message.type === "assistant" && Array.isArray(message.content)) {
    const parts: string[] = []
    for (const part of message.content) {
      if (!isRecord(part)) continue
      if (typeof part.text === "string" && part.text) parts.push(part.text)
      else if (typeof part.tool === "string" && part.tool) parts.push(`[tool ${part.tool}]`)
    }
    return parts.join("\n")
  }
  return typeof message.text === "string" ? message.text : ""
}

/** Newest-first bounded previews; unknown shapes degrade to an empty preview, never a throw. */
export function summarizeSessionMessages(messages: readonly unknown[]): SessionMessageSummary[] {
  return messages.slice(-MAX_SESSION_MESSAGES).map((message) => {
    if (!isRecord(message)) return { type: "unknown", preview: "" }
    const type = typeof message.type === "string" && message.type ? message.type : "unknown"
    return { type, preview: truncateText(extractPreview(message), MESSAGE_PREVIEW_LIMIT) }
  })
}
