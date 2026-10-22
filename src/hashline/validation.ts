import { computeLegacyLineHash, computeLineHash, HASHLINE_REF_PATTERN } from "./hash"

export class HashlineMismatchError extends Error {
  readonly remaps: Map<string, string>
  constructor(message: string, remaps: Map<string, string>) {
    super(message)
    this.name = "HashlineMismatchError"
    this.remaps = remaps
  }
}

/** Strip decorations models add around a LINE#ID reference. */
export function normalizeLineRef(ref: string): string {
  let value = ref.trim().replace(/^(?:>>>|[+-])\s*/, "")
  value = value.replace(/\s*#\s*/, "#")
  value = value.replace(/\|.*$/, "").trim()
  if (HASHLINE_REF_PATTERN.test(value)) return value
  const embedded = value.match(/[0-9]+#[ZPMQVRWSNKTXJBYH]{2}/)
  return embedded ? embedded[0] : value
}

export function parseLineRef(ref: string): { line: number; hash: string } {
  const normalized = normalizeLineRef(ref)
  const match = HASHLINE_REF_PATTERN.exec(normalized)
  if (match) return { line: Number(match[1]), hash: match[2] ?? "" }
  const parts = normalized.split("#")
  if (
    parts.length === 2 &&
    /^[ZPMQVRWSNKTXJBYH]{2}$/.test(parts[1] ?? "") &&
    !/^[0-9]+$/.test(parts[0] ?? "")
  ) {
    throw new Error(
      `Invalid line reference: "${normalized}". "${parts[0]}" is not a line number. Use the actual line number from the read output.`,
    )
  }
  throw new Error(
    `Invalid line reference format: "${normalized}". Expected format: "{line_number}#{hash_id}"`,
  )
}

/** Find the line that still carries the given hash, for parse-error hints. */
export function suggestLineForHash(lines: string[], ref: string): string | undefined {
  const hash = normalizeLineRef(ref).split("#")[1]
  if (!hash || !/^[ZPMQVRWSNKTXJBYH]{2}$/.test(hash)) return undefined
  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index] ?? ""
    if (
      computeLineHash(index + 1, content) === hash ||
      computeLegacyLineHash(index + 1, content) === hash
    ) {
      return `${index + 1}#${hash}`
    }
  }
  return undefined
}

function createMismatch(lines: string[], stale: Map<number, string[]>): HashlineMismatchError {
  const changed = [...stale.keys()].sort((left, right) => left - right)
  const remaps = new Map<string, string>()
  for (const line of changed) {
    const content = lines[line - 1] ?? ""
    const fresh = `${line}#${computeLineHash(line, content)}`
    for (const refOfLine of stale.get(line) ?? []) remaps.set(refOfLine, fresh)
  }
  const count = changed.length
  const firstNew = changed[0]
    ? `${changed[0]}#${computeLineHash(changed[0], lines[changed[0] - 1] ?? "")}`
    : ""
  const header =
    `${count} line${count === 1 ? "" : "s"} ${count === 1 ? "has" : "have"} changed since last read. ` +
    `Use updated ${firstNew} references below (>>> marks changed lines).`
  const display = new Set<number>()
  for (const line of changed) {
    for (let context = line - 2; context <= line + 2; context += 1) {
      if (context >= 1 && context <= lines.length) display.add(context)
    }
  }
  const body: string[] = []
  let previous = 0
  for (const line of [...display].sort((left, right) => left - right)) {
    if (previous && line > previous + 1) body.push("    ...")
    const content = lines[line - 1] ?? ""
    const hash = computeLineHash(line, content)
    body.push(
      changed.includes(line) ? `>>> ${line}#${hash}|${content}` : `    ${line}#${hash}|${content}`,
    )
    previous = line
  }
  return new HashlineMismatchError(`${header}\n\n${body.join("\n")}`, remaps)
}

/**
 * Validate every reference against current line content: parse, bounds, then
 * hash match (current or legacy). Collects all stale refs into one mismatch
 * error carrying remaps to the fresh references.
 */
export function assertLineRefs(lines: string[], refs: string[]): void {
  const stale = new Map<number, string[]>()
  for (const ref of refs) {
    if (!ref) continue
    const { line, hash } = parseLineRef(ref)
    if (line < 1 || line > lines.length) {
      throw new Error(`Line number ${line} out of bounds. File has ${lines.length} lines.`)
    }
    const content = lines[line - 1] ?? ""
    if (hash === computeLineHash(line, content) || hash === computeLegacyLineHash(line, content)) {
      continue
    }
    stale.set(line, [...(stale.get(line) ?? []), ref])
  }
  if (stale.size > 0) throw createMismatch(lines, stale)
}

export function validateLineRef(lines: string[], ref: string): void {
  assertLineRefs(lines, [ref])
}
