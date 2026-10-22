import type { ConversationSnapshot, ReflectionTrigger } from "./reflection-queue"

export type IngestOutcome = "ingested" | "deduplicated" | "rejected" | "skipped"

export interface CompactionInput {
  sessionID: string
  result?: { summary?: string }
  messages?: unknown[]
  system?: { type: string; text: string }[]
}

/** Host context hook payload: the conversation about to be sent, per model request. */
export interface StepInput {
  sessionID: string
  agent?: string
  result?: { summary?: string }
  messages?: unknown[]
  system?: unknown[]
}

export interface IngestDeps {
  enqueue(snapshot: ConversationSnapshot): boolean
  admit(sessionID: string, signal: AbortSignal): Promise<void> | void
  signal?: AbortSignal
  maxChars?: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Uses the host's decided compaction summary when present. Otherwise derives the
 * snapshot from conversation text parts only: system messages and non-text parts
 * (reasoning, media, tool output) are never ingested. The V2 model-request
 * shape is `{ role, content: [{ type: "text", text }] }` — there are no `parts`.
 */
function deriveText(messages: unknown[] | undefined, maxChars: number): string {
  const lines: string[] = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!record(message)) continue
    const { role, content } = message
    if (typeof role !== "string" || !role.trim() || !Array.isArray(content)) continue
    const texts = content
      .filter((part) => record(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => (part as { text: string }).text.trim())
      .filter((text) => text.length > 0)
    if (texts.length) lines.push(`${role}: ${texts.join(" ")}`)
  }
  return lines.join("\n").slice(0, maxChars)
}

function selectText(input: CompactionInput, maxChars: number): string {
  const summary = input.result?.summary
  if (typeof summary === "string" && summary.trim()) return summary.trim().slice(0, maxChars)
  return deriveText(input.messages, maxChars)
}

/**
 * Builds the compaction-triggered snapshot handler. It never throws: a host
 * compaction must not fail because reflection bookkeeping failed. Foreign
 * sessions, aborted mounts and unusable input resolve to "skipped"; queue
 * limit failures resolve to "rejected".
 */
export function createCompactionIngest(
  deps: IngestDeps,
): (input: CompactionInput) => Promise<IngestOutcome> {
  return build(deps, (input, maxChars) => selectText(input, maxChars), "compaction")
}

/**
 * Builds the step-triggered snapshot handler. A step snapshot is always derived
 * from conversation text: a decided compaction summary is never reused here, so a
 * step observation cannot silently re-queue a previous summary. Same fail-closed
 * contract as compaction ingestion.
 */
export function createStepIngest(deps: IngestDeps): (input: StepInput) => Promise<IngestOutcome> {
  return build(deps, (input, maxChars) => deriveText(input.messages, maxChars), "step")
}

function build<Input extends { sessionID?: unknown }>(
  deps: IngestDeps,
  select: (input: Input, maxChars: number) => string,
  trigger: ReflectionTrigger,
): (input: Input) => Promise<IngestOutcome> {
  const maxChars = deps.maxChars ?? 8000
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("invalid-ingest-budget")
  const controller = new AbortController()
  const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal
  return async (input: Input) => {
    if (signal.aborted) return "skipped"
    const sessionID = input?.sessionID
    if (typeof sessionID !== "string" || !sessionID.trim()) return "skipped"
    const text = select(input, maxChars)
    if (!text) return "skipped"
    try {
      await deps.admit(sessionID, signal)
    } catch {
      return "skipped"
    }
    if (signal.aborted) return "skipped"
    try {
      return deps.enqueue({ sessionID, text, trigger }) ? "ingested" : "deduplicated"
    } catch {
      return "rejected"
    }
  }
}
