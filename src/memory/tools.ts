import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { commitReviewedMemories } from "./commit"
import { formatMemories, formatReflections } from "./compile"
import { type DreamConfig, dreamVerdict, validateDreamConfig } from "./dream"
import { createCompactionIngest, createStepIngest } from "./ingest"
import { openReflectionQueue, type ReflectionTrigger } from "./reflection-queue"
import { type MemoryStore, memoryScope, openMemoryStore } from "./store"

const SAVE_DESCRIPTION =
  "Persist a durable memory entry scoped to this project. Provide content (required), " +
  "an optional stable key (lowercase, dots/dashes) and optional tags. Saving identical " +
  "content again is a no-op (deduplicated); saving new content under an existing key " +
  "bumps its revision and keeps history."

const RECALL_DESCRIPTION =
  "Search this project's saved memories by keywords. Returns ranked matches with key, " +
  "revision, content and tags. Pass reflections=true to also append the latest " +
  "reflection-log entries. Use memory_save to store anything worth recalling later."

const REFLECT_DESCRIPTION =
  "Record a reflection in this project's append-only reflection log: a correction, " +
  "preference, fact or decision worth reusing later. Reflections are returned by " +
  "memory_recall with reflections=true and merged by the recall compiler."

type SaveInput = { content: string; key?: string; tags?: string[] }
type RecallInput = { query: string; limit?: number; reflections?: boolean }
type ReflectInput = { kind: string; summary: string; detail?: string }

function renderSave(store: MemoryStore, scope: string, input: SaveInput): string {
  const result = store.save(scope, input)
  const tags = input.tags?.length ? ` (tags: ${input.tags.join(", ")})` : ""
  return `${result.status}: ${result.key} @ revision ${result.revision}${tags}`
}

function renderRecall(store: MemoryStore, scope: string, input: RecallInput): string {
  const items = store.recall(scope, input.query, input.limit ?? 5)
  if (items.length === 0 && input.reflections !== true) return `0 match(es) for "${input.query}"`
  const memories = items.length > 0 ? formatMemories(items) : `0 match(es) for "${input.query}"`
  if (input.reflections !== true) return memories
  const reflections = formatReflections(store.listReflections(scope, 5))
  return `## Memories\n${memories}\n\n## Reflections\n${reflections.length > 0 ? reflections : "no reflections recorded"}`
}

function renderReflect(store: MemoryStore, scope: string, input: ReflectInput): string {
  const entry = store.recordReflection(scope, input)
  return `reflection ${entry.id} recorded (${entry.kind}): ${entry.summary}`
}

/**
 * Register the memory save/recall tools (gated by `memory_enabled`). Storage is
 * the per-project SQLite file under `stateHome`, the caller-supplied project
 * state directory (created here when missing); scopes keep projects from seeing
 * each other's entries.
 *
 * `dream` carries the dream/time policy. It is validated before anything is
 * created: a malformed policy fails the mount instead of half-applying, and an
 * absent policy means the documented defaults (enabled, 30 idle minutes, a 24
 * hour cadence).
 */
export async function mountMemory(
  ctx: Plugin.Context,
  stateHome: string,
  enabled: boolean,
  dream?: DreamConfig,
): Promise<() => Promise<void>> {
  if (!enabled) return async () => {}
  const dreamConfig = validateDreamConfig(dream)
  const file = join(stateHome, "memory.sqlite")
  mkdirSync(stateHome, { recursive: true })
  const store = openMemoryStore(file)
  const scope = memoryScope(ctx.location.project.id, ctx.location.directory)
  const controller = new AbortController()
  async function authorize(context: { sessionID?: string; signal?: AbortSignal }) {
    const signal = context.signal
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal
    signal.throwIfAborted()
    const sessionID = context.sessionID
    if (typeof sessionID !== "string" || !sessionID.trim())
      throw new Error("native-session-required")
    const session = await ctx.session.get({ sessionID }, { signal })
    signal.throwIfAborted()
    if (
      session.id !== sessionID ||
      session.projectID !== ctx.location.project.id ||
      session.location.directory !== ctx.location.directory
    )
      throw new Error("foreign-session")
    return sessionID
  }
  const queueFor = (sessionID: string) =>
    openReflectionQueue(stateHome, JSON.stringify([scope, sessionID]), undefined, dreamConfig)
  try {
    const registration = await ctx.tool.transform((editor) => {
      editor.namespace({ name: "omo", description: "OmO custom tools" })
      if (
        editor.get("omo_memory_save") ||
        editor.get("omo_memory_recall") ||
        editor.get("omo_memory_reflect") ||
        editor.get("omo_memory_pipeline") ||
        editor.get("omo_memory_reflection_state") ||
        editor.get("omo_memory_commit")
      )
        throw new Error(
          "memory tool collision: omo_memory_save/omo_memory_recall/omo_memory_reflect",
        )
      editor.add({
        name: "memory_save",
        description: SAVE_DESCRIPTION,
        options: { namespace: "omo", permission: "edit" },
        output: {},
        input: {
          type: "object",
          properties: {
            content: { type: "string", description: "Memory content to persist (required)" },
            key: {
              type: "string",
              description: "Optional stable key: ^[a-z0-9][a-z0-9._-]{0,63}$",
            },
            tags: {
              type: "array",
              description: "Up to 8 tags of 1..32 characters",
              items: { type: "string" },
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
        async execute(input, context) {
          await authorize(context)
          return { output: renderSave(store, scope, input as SaveInput) }
        },
      })
      editor.add({
        name: "memory_recall",
        description: RECALL_DESCRIPTION,
        options: { namespace: "omo", permission: "read" },
        output: {},
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keywords to search for (required)" },
            limit: { type: "number", description: "Max results, 1..20 (default 5)" },
            reflections: {
              type: "boolean",
              description: "Also append the latest reflection-log entries",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(input, context) {
          await authorize(context)
          return { output: renderRecall(store, scope, input as RecallInput) }
        },
      })
      editor.add({
        name: "memory_reflect",
        description: REFLECT_DESCRIPTION,
        options: { namespace: "omo", permission: "edit" },
        output: {},
        input: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              description: "Reflection kind: correction, preference, fact or decision",
            },
            summary: { type: "string", description: "Short summary, 1..2000 characters" },
            detail: { type: "string", description: "Optional longer note, up to 65536 characters" },
          },
          required: ["kind", "summary"],
          additionalProperties: false,
        },
        async execute(input, context) {
          await authorize(context)
          return { output: renderReflect(store, scope, input as ReflectInput) }
        },
      })
      editor.add({
        name: "memory_reflection_state",
        description:
          "Read this native session's durable reflection reservation, pending snapshots and the dream/time verdict (due, or the exact reason it is refused). Does not claim, settle or recover work.",
        options: { namespace: "omo", permission: "read" },
        output: {},
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, context) {
          const sessionID = await authorize(context)
          const queue = queueFor(sessionID)
          const observation = queue.dreamState()
          const verdict = dreamVerdict(
            dreamConfig,
            {
              activityAt: observation.activityAt ?? undefined,
              dreamAt: observation.dreamAt ?? undefined,
              dreamDue: observation.dreamDue,
            },
            Date.now(),
          )
          const content = JSON.stringify({
            ...queue.inspect(),
            dream: { ...verdict, ...observation },
          })
          return { content, output: content }
        },
      })
      editor.add({
        name: "memory_pipeline",
        description:
          "Manage a bounded reflection queue for this native session: ingest a snapshot, reserve one run, settle after processing it, or explicitly recover an interrupted reservation. trigger dream is accepted only when the queue observed an idle gap of at least the configured minutes and the dream cadence elapsed; otherwise the call fails loudly with dream-disabled, dream-no-idle-gap or dream-too-soon. A reserved run persists across restart; it is never retried automatically. Save reviewed memories with memory_save before settling merged. no_changes confirms review produced no reusable memory.",
        options: { namespace: "omo", permission: "edit" },
        output: {},
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["ingest", "reserve", "settle", "recover"] },
            text: { type: "string" },
            trigger: { type: "string", enum: ["manual", "compaction", "step", "dream"] },
            runID: { type: "string" },
            outcome: { type: "string", enum: ["merged", "no_changes", "failed"] },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const sessionID = await authorize(context)
          const args = input as {
            action: string
            text?: string
            trigger?: ReflectionTrigger
            runID?: string
            outcome?: "merged" | "no_changes" | "failed"
          }
          const queue = queueFor(sessionID)
          let result: unknown
          switch (args.action) {
            case "ingest":
              if (typeof args.text !== "string" || !args.trigger)
                throw new Error("snapshot-required")
              result = {
                queued: queue.enqueue({ sessionID, text: args.text, trigger: args.trigger }),
              }
              break
            case "reserve":
              result = queue.reserve()
              break
            case "settle":
              if (!args.runID || !args.outcome) throw new Error("reservation-outcome-required")
              queue.settle(args.runID, args.outcome)
              result = queue.inspect()
              break
            case "recover":
              if (!args.runID) throw new Error("reservation-required")
              queue.recover(args.runID)
              result = queue.inspect()
              break
            default:
              throw new Error("invalid-pipeline-action")
          }
          const content = JSON.stringify(result)
          return { content, output: content }
        },
      })
      editor.add({
        name: "memory_commit",
        description:
          "Commit reviewed memories to git inside this project's repository. Each entry becomes one markdown file under the memory directory, recorded in one commit limited to those files. Identical content records nothing. Unrelated dirty work and a pre-staged index are refused, never committed. Requires a local git binary and write access to the repository.",
        options: { namespace: "omo", permission: "edit" },
        output: {},
        input: {
          type: "object",
          properties: {
            entries: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  key: { type: "string", minLength: 1 },
                  content: { type: "string", minLength: 1 },
                  tags: { type: "array", items: { type: "string" } },
                  revision: { type: "integer" },
                },
                required: ["key", "content"],
                additionalProperties: false,
              },
            },
            message: { type: "string" },
            dir: { type: "string" },
          },
          required: ["entries"],
          additionalProperties: false,
        },
        async execute(input, context) {
          await authorize(context)
          const args = input as {
            entries: Parameters<typeof commitReviewedMemories>[1][number][]
            message?: string
            dir?: string
          }
          const result = await commitReviewedMemories(
            ctx.location.project.canonical,
            args.entries,
            {
              message: args.message,
              dir: args.dir,
            },
          )
          const content = JSON.stringify(result)
          return { content, output: content }
        },
      })
    })
    const ingest = createCompactionIngest({
      signal: controller.signal,
      enqueue: (snapshot) => queueFor(snapshot.sessionID).enqueue(snapshot),
      admit: async (sessionID, signal) => {
        await authorize({ sessionID, signal })
      },
    })
    const ingestion = await ctx.session.hook("compaction", async (input) => {
      await ingest({
        sessionID: input.sessionID,
        result: input.result,
        messages: input.messages,
      })
    })
    const stepIngest = createStepIngest({
      signal: controller.signal,
      enqueue: (snapshot) => queueFor(snapshot.sessionID).enqueue(snapshot),
      admit: async (sessionID, signal) => {
        await authorize({ sessionID, signal })
      },
    })
    // The host context hook runs once per model request for every agent loop, so
    // this observes step-level conversation text without polling host state.
    const stepIngestion = await ctx.session.hook("context", async (input) => {
      await stepIngest({
        sessionID: input.sessionID,
        agent: input.agent,
        messages: input.messages,
      })
    })
    return async () => {
      await ingestion.dispose()
      await stepIngestion.dispose()
      controller.abort()
      registration.dispose()
      store.close()
    }
  } catch (error) {
    store.close()
    throw error
  }
}
