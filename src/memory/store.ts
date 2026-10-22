import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"

const MAX_CONTENT_BYTES = 65536
const MAX_TAGS = 8
const MAX_SUMMARY_CHARS = 2000
const MAX_DETAIL_CHARS = 65536
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const AUTO_KEY_PATTERN = /^mem-[0-9a-f]{12}$/

type SaveStatus = "created" | "updated" | "unchanged"

type SaveResult = {
  status: SaveStatus
  key: string
  revision: number
}

export type RecallItem = {
  key: string
  revision: number
  content: string
  tags: string[]
  score: number
  updatedAt: number
}

type HistoryRow = {
  revision: number
  content: string
  savedAt: number
}

export type ReflectionKind = "correction" | "preference" | "fact" | "decision"

const REFLECTION_KINDS: ReflectionKind[] = ["correction", "preference", "fact", "decision"]

type RecordReflectionInput = {
  kind: string
  summary: string
  detail?: string
}

export type ReflectionEntry = {
  id: string
  kind: ReflectionKind
  summary: string
  detail?: string
  recordedAt: number
}

type Row = {
  key: string
  revision: number
  content: string
  content_hash: string
  tags: string
  updated_at: number
}

/** Scope key isolating memories per project/location (contamination guard). */
export function memoryScope(projectID: string, locationID: string): string {
  return JSON.stringify(["shtora.omo.memory", projectID, locationID])
}

function autoKey(content: string): string {
  return `mem-${createHash("sha256").update(content).digest("hex").slice(0, 12)}`
}

function validateContent(content: unknown): string {
  if (typeof content !== "string" || content.trim().length === 0)
    throw new Error("memory save: content must be a non-empty string")
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES)
    throw new Error(`memory save: content exceeds ${MAX_CONTENT_BYTES} bytes`)
  return content
}

function validateKey(key: string): string {
  if (!KEY_PATTERN.test(key) || AUTO_KEY_PATTERN.test(key))
    throw new Error(
      "memory save: key must match ^[a-z0-9][a-z0-9._-]{0,63}$ and must not look like an auto key",
    )
  return key
}

function normalizeTags(tags: unknown): string[] {
  if (tags === undefined) return []
  if (!Array.isArray(tags)) throw new Error("memory save: tags must be an array of strings")
  if (tags.length > MAX_TAGS) throw new Error(`memory save: at most ${MAX_TAGS} tags allowed`)
  return tags.map((tag) => {
    if (typeof tag !== "string" || tag.length < 1 || tag.length > 32)
      throw new Error("memory save: each tag must be 1..32 characters")
    return tag
  })
}

function parseTags(raw: string): string[] {
  if (!raw) return []
  return JSON.parse(raw) as string[]
}

function tokenize(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
  return [...new Set(tokens)]
}

export type MemoryStore = {
  save(scope: string, input: { content: string; key?: string; tags?: string[] }): SaveResult
  recall(scope: string, query: string, limit?: number): RecallItem[]
  history(scope: string, key: string): HistoryRow[]
  recordReflection(scope: string, input: RecordReflectionInput): ReflectionEntry
  listReflections(scope: string, limit?: number): ReflectionEntry[]
  close(): void
}

/**
 * SQLite-backed memory store with per-scope isolation, revisioned history and
 * content-hash deduplication. One file per project directory (WAL, busy_timeout).
 */
export function openMemoryStore(path: string): MemoryStore {
  const db = new Database(path)
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA journal_mode = WAL")
  db.run(`CREATE TABLE IF NOT EXISTS omo_memory (
    scope TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
    content TEXT NOT NULL, content_hash TEXT NOT NULL, tags TEXT NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY (scope, key))`)
  db.run(`CREATE TABLE IF NOT EXISTS omo_memory_history (
    scope TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
    content TEXT NOT NULL, content_hash TEXT NOT NULL, saved_at INTEGER NOT NULL,
    PRIMARY KEY (scope, key, revision))`)

  const get = db.query<Row, [string, string]>(
    "SELECT key, revision, content, content_hash, tags, updated_at FROM omo_memory WHERE scope = ? AND key = ?",
  )
  const listScope = db.query<Row, [string]>(
    "SELECT key, revision, content, content_hash, tags, updated_at FROM omo_memory WHERE scope = ?",
  )
  const insert = db.query(
    "INSERT INTO omo_memory (scope, key, revision, content, content_hash, tags, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  const update = db.query(
    "UPDATE omo_memory SET revision = ?, content = ?, content_hash = ?, tags = ?, updated_at = ? WHERE scope = ? AND key = ?",
  )
  const insertHistory = db.query(
    "INSERT INTO omo_memory_history (scope, key, revision, content, content_hash, saved_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
  const historyRows = db.query<
    { revision: number; content: string; saved_at: number },
    [string, string]
  >(
    "SELECT revision, content, saved_at FROM omo_memory_history WHERE scope = ? AND key = ? ORDER BY revision",
  )
  db.run(`CREATE TABLE IF NOT EXISTS omo_memory_reflections (
    scope TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
    summary TEXT NOT NULL, detail TEXT NOT NULL, recorded_at INTEGER NOT NULL,
    PRIMARY KEY (scope, id))`)
  const insertReflection = db.query(
    "INSERT INTO omo_memory_reflections (scope, id, kind, summary, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
  const reflectionRows = db.query<
    { id: string; kind: string; summary: string; detail: string; recorded_at: number },
    [string, number]
  >(
    "SELECT id, kind, summary, detail, recorded_at FROM omo_memory_reflections WHERE scope = ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?",
  )

  function validateReflection(input: RecordReflectionInput): {
    kind: ReflectionKind
    summary: string
    detail?: string
  } {
    if (!REFLECTION_KINDS.includes(input.kind as ReflectionKind))
      throw new Error(`memory reflect: kind must be one of ${REFLECTION_KINDS.join(", ")}`)
    if (typeof input.summary !== "string" || input.summary.trim().length === 0)
      throw new Error("memory reflect: summary must be a non-empty string")
    if (input.summary.length > MAX_SUMMARY_CHARS)
      throw new Error(`memory reflect: summary exceeds ${MAX_SUMMARY_CHARS} characters`)
    if (input.detail !== undefined) {
      if (typeof input.detail !== "string")
        throw new Error("memory reflect: detail must be a string")
      if (input.detail.length > MAX_DETAIL_CHARS)
        throw new Error(`memory reflect: detail exceeds ${MAX_DETAIL_CHARS} characters`)
    }
    return {
      kind: input.kind as ReflectionKind,
      summary: input.summary,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    }
  }

  const save = db.transaction(
    (scope: string, input: { content: string; key?: string; tags?: string[] }): SaveResult => {
      const content = validateContent(input.content)
      const tags = normalizeTags(input.tags)
      const key = input.key === undefined ? autoKey(content) : validateKey(input.key)
      const contentHash = createHash("sha256").update(content).digest("hex")
      const now = Date.now()
      const existing = get.get(scope, key)
      if (existing) {
        if (existing.content_hash === contentHash)
          return { status: "unchanged", key, revision: existing.revision }
        const revision = existing.revision + 1
        update.run(revision, content, contentHash, JSON.stringify(tags), now, scope, key)
        insertHistory.run(scope, key, revision, content, contentHash, now)
        return { status: "updated", key, revision }
      }
      insert.run(scope, key, 1, content, contentHash, JSON.stringify(tags), now)
      insertHistory.run(scope, key, 1, content, contentHash, now)
      return { status: "created", key, revision: 1 }
    },
  )

  let closed = false
  return {
    save(scope, input) {
      return save.immediate(scope, input)
    },
    recall(scope, query, limit = 5) {
      if (typeof query !== "string" || query.trim().length === 0)
        throw new Error("memory recall: query must be a non-empty string")
      const bounded = Math.min(20, Math.max(1, Math.trunc(limit)))
      const tokens = tokenize(query)
      const scored: RecallItem[] = []
      for (const row of listScope.all(scope)) {
        const content = row.content.toLowerCase()
        const key = row.key.toLowerCase()
        const tags = parseTags(row.tags)
        let score = 0
        for (const token of tokens) {
          let index = content.indexOf(token)
          while (index !== -1) {
            score += 1
            index = content.indexOf(token, index + token.length)
          }
          if (key.includes(token)) score += 2
          for (const tag of tags) if (tag.toLowerCase().includes(token)) score += 2
        }
        if (score > 0)
          scored.push({
            key: row.key,
            revision: row.revision,
            content: row.content,
            tags,
            score,
            updatedAt: row.updated_at,
          })
      }
      scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      return scored.slice(0, bounded)
    },
    history(scope, key) {
      return historyRows.all(scope, key).map((row) => ({
        revision: row.revision,
        content: row.content,
        savedAt: row.saved_at,
      }))
    },
    recordReflection(scope, input) {
      const validated = validateReflection(input)
      const entry: ReflectionEntry = {
        id: randomUUID(),
        kind: validated.kind,
        summary: validated.summary,
        ...(validated.detail === undefined ? {} : { detail: validated.detail }),
        recordedAt: Date.now(),
      }
      insertReflection.run(
        scope,
        entry.id,
        entry.kind,
        entry.summary,
        entry.detail ?? "",
        entry.recordedAt,
      )
      return entry
    },
    listReflections(scope, limit = 20) {
      const bounded = Math.min(100, Math.max(1, Math.trunc(limit)))
      return reflectionRows.all(scope, bounded).map((row) => ({
        id: row.id,
        kind: row.kind as ReflectionKind,
        summary: row.summary,
        ...(row.detail ? { detail: row.detail } : {}),
        recordedAt: row.recorded_at,
      }))
    },
    close() {
      if (!closed) {
        db.close(true)
        closed = true
      }
    },
  }
}
