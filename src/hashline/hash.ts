// Hash-anchored line references (LINE#ID). Own implementation for @shtora/omo.
export const NIBBLE_STR = "ZPMQVRWSNKTXJBYH"

export const HASHLINE_DICT: string[] = Array.from(
  { length: 256 },
  (_, value) => NIBBLE_STR.charAt(value >>> 4) + NIBBLE_STR.charAt(value & 0xf),
)

export const HASHLINE_REF_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/
export const HASHLINE_OUTPUT_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})\|(.*)$/

const CONTAINS_WORD_CHAR = /[\p{L}\p{N}]/u

function hashNormalized(lineNumber: number, normalized: string): string {
  const seed = CONTAINS_WORD_CHAR.test(normalized) ? 0 : lineNumber
  // xxHash32 is a uint32, so the digest modulo 256 is always a valid charAt index.
  const digest = Bun.hash.xxHash32(normalized, seed) % 256
  return NIBBLE_STR.charAt(digest >>> 4) + NIBBLE_STR.charAt(digest & 0xf)
}

/** Two-char content tag for a line; content-bearing lines seed by content alone. */
export function computeLineHash(lineNumber: number, content: string): string {
  return hashNormalized(lineNumber, content.replace(/\r/g, "").trimEnd())
}

/** Legacy tag strips all whitespace; validation accepts either form. */
export function computeLegacyLineHash(lineNumber: number, content: string): string {
  const stripped = content.replace(/\r/g, "").trimEnd().replace(/\s+/g, "")
  return hashNormalized(lineNumber, stripped)
}

export function formatHashLine(lineNumber: number, content: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, content)}|${content}`
}

export function formatHashLines(content: string): string[] {
  return content.split("\n").map((line, index) => formatHashLine(index + 1, line))
}
