import type { MemoryStore, RecallItem, ReflectionEntry } from "./store"

/**
 * Minimal recall compiler: merges ranked memory matches with the latest
 * reflection-log entries into one context block. Reflections are a plain
 * append-only log (no scoring, no dedup); the caller opts in explicitly.
 */
export function formatMemories(items: RecallItem[]): string {
  return items
    .map(
      (item) =>
        `${item.key} (rev ${item.revision}, score ${item.score}, tags: ${item.tags.join(", ") || "-"})\n${item.content}`,
    )
    .join("\n---\n")
}

export function formatReflections(entries: ReflectionEntry[]): string {
  return entries
    .map((entry) =>
      entry.detail
        ? `[${entry.kind}] ${entry.summary}\n${entry.detail}`
        : `[${entry.kind}] ${entry.summary}`,
    )
    .join("\n---\n")
}

export function compileMemoryContext(
  store: MemoryStore,
  scope: string,
  query: string,
  options?: { memoryLimit?: number; reflectionLimit?: number },
): string {
  const memories = formatMemories(store.recall(scope, query, options?.memoryLimit ?? 5))
  const reflections = formatReflections(store.listReflections(scope, options?.reflectionLimit ?? 5))
  const memorySection = memories.length > 0 ? memories : `0 match(es) for "${query}"`
  const reflectionSection = reflections.length > 0 ? reflections : "no reflections recorded"
  return `## Memories\n${memorySection}\n\n## Reflections\n${reflectionSection}`
}
