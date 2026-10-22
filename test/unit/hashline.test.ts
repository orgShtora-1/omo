import { describe, expect, test } from "bun:test"
import { applyHashlineEdits } from "../../src/hashline/edit"
import { transformHashlineRead } from "../../src/hashline/enhancer"
import {
  computeLegacyLineHash,
  computeLineHash,
  formatHashLine,
  formatHashLines,
  HASHLINE_DICT,
  HASHLINE_OUTPUT_PATTERN,
  HASHLINE_REF_PATTERN,
  NIBBLE_STR,
} from "../../src/hashline/hash"
import { normalizeEdits } from "../../src/hashline/normalize"
import {
  HashlineMismatchError,
  normalizeLineRef,
  parseLineRef,
  suggestLineForHash,
  validateLineRef,
} from "../../src/hashline/validation"

const ref = (line: number, content: string) => `${line}#${computeLineHash(line, content)}`

describe("hash computation", () => {
  test("produces a two-char tag from the CID alphabet", () => {
    for (const [line, content] of [
      [1, "const x = 1"],
      [42, "hello world"],
      [7, ""],
      [3, "   "],
      [9, "日本語のテキスト"],
    ] as Array<[number, string]>) {
      const hash = computeLineHash(line, content)
      expect(hash).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/)
    }
  })

  test("is stable for the same line number and content", () => {
    expect(computeLineHash(5, "stable line")).toBe(computeLineHash(5, "stable line"))
  })

  test("ignores carriage returns and trailing whitespace", () => {
    expect(computeLineHash(1, "abc\r")).toBe(computeLineHash(1, "abc"))
    expect(computeLineHash(1, "abc   ")).toBe(computeLineHash(1, "abc"))
  })

  test("seeds content-bearing lines by content alone", () => {
    expect(computeLineHash(1, "hello world")).toBe(computeLineHash(2, "hello world"))
    expect(computeLineHash(1, "123")).toBe(computeLineHash(9, "123"))
  })

  test("seeds whitespace-only lines by position", () => {
    expect(computeLineHash(1, "   ")).not.toBe(computeLineHash(3, "   "))
  })

  test("legacy hash strips all whitespace", () => {
    expect(computeLegacyLineHash(1, "  a b\tc ")).toBe(computeLegacyLineHash(1, "abc"))
    expect(computeLegacyLineHash(1, "  a b\tc ")).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/)
  })

  test("format helpers and reference patterns agree", () => {
    expect(formatHashLine(3, "x")).toBe(`3#${computeLineHash(3, "x")}|x`)
    expect(formatHashLines("a\nb")).toEqual([
      `1#${computeLineHash(1, "a")}|a`,
      `2#${computeLineHash(2, "b")}|b`,
    ])
    expect("42#VK".match(HASHLINE_REF_PATTERN)).not.toBeNull()
    expect("42#AA".match(HASHLINE_REF_PATTERN)).toBeNull()
    expect("42#V".match(HASHLINE_REF_PATTERN)).toBeNull()
    const output = "17#VK|text".match(HASHLINE_OUTPUT_PATTERN)
    expect(output?.[1]).toBe("17")
    expect(output?.[2]).toBe("VK")
    expect(output?.[3]).toBe("text")
    expect(HASHLINE_DICT).toHaveLength(256)
    for (const tag of HASHLINE_DICT) expect(tag).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/)
    expect(NIBBLE_STR).toHaveLength(16)
  })
})

describe("read enhancer", () => {
  test("tags colon-prefixed read output", () => {
    const input = "1: const a = 1\n2: const b = 2"
    expect(transformHashlineRead(input)).toBe(
      `1#${computeLineHash(1, "const a = 1")}|const a = 1\n2#${computeLineHash(2, "const b = 2")}|const b = 2`,
    )
  })

  test("tags pipe-prefixed read output and indented numbers", () => {
    expect(transformHashlineRead("3| baz")).toBe(`3#${computeLineHash(3, "baz")}|baz`)
    expect(transformHashlineRead("  12: x")).toBe(`12#${computeLineHash(12, "x")}|x`)
  })

  test("leaves non-tagged output untouched", () => {
    const binary = "PNG data\n\x00\x01 more"
    expect(transformHashlineRead(binary)).toBe(binary)
  })

  test("leaves truncated lines and already-tagged output untouched", () => {
    const truncated = "1: hello... (line truncated to 2000 chars)"
    expect(transformHashlineRead(truncated)).toBe(truncated)
    const tagged = `1#${computeLineHash(1, "a")}|a`
    expect(transformHashlineRead(tagged)).toBe(tagged)
  })

  test("transforms only inside content blocks", () => {
    const input = "<content>\n1: a\n2: b\n</content>"
    expect(transformHashlineRead(input)).toBe(
      `<content>\n1#${computeLineHash(1, "a")}|a\n2#${computeLineHash(2, "b")}|b\n</content>`,
    )
  })

  test("stops at the first unparsable line inside a block", () => {
    const input = "<content>\n1: a\nnot a line\n1: b"
    expect(transformHashlineRead(input)).toBe(
      `<content>\n1#${computeLineHash(1, "a")}|a\nnot a line\n1: b`,
    )
  })

  test("tags numbered lines after a leading human-readable header", () => {
    const input = "Read file /tmp/notes.txt, lines 1-3\n1: alpha\n2: beta\n3: gamma"
    expect(transformHashlineRead(input)).toBe(
      `Read file /tmp/notes.txt, lines 1-3\n1#${computeLineHash(1, "alpha")}|alpha\n2#${computeLineHash(2, "beta")}|beta\n3#${computeLineHash(3, "gamma")}|gamma`,
    )
  })
})

describe("edit normalization", () => {
  test("replace requires an anchor", () => {
    expect(() => normalizeEdits([{ op: "replace", lines: ["x"] }])).toThrow(
      "Edit 0: replace requires at least one anchor line reference (pos or end)",
    )
  })

  test("lines are required for every op", () => {
    expect(() => normalizeEdits([{ op: "append" }])).toThrow("Edit 0: lines is required for append")
    expect(() => normalizeEdits([{ op: "replace", pos: "1#AB" }])).toThrow(
      "Edit 0: lines is required for replace",
    )
  })

  test("trims anchors, splits string lines and maps null to empty", () => {
    const edits = normalizeEdits([
      { op: "replace", pos: `  ${ref(1, "a")}  `, lines: null },
      { op: "append", pos: "", lines: "x\ny" },
      { op: "prepend", lines: ["top"] },
    ])
    expect(edits).toEqual([
      { op: "replace", pos: ref(1, "a"), lines: [] },
      { op: "append", pos: undefined, lines: ["x", "y"] },
      { op: "prepend", pos: undefined, lines: ["top"] },
    ])
  })

  test("rejects unknown ops with the legacy-format message", () => {
    expect(() => normalizeEdits([{ op: "insert", lines: ["x"] }])).toThrow(
      'Edit 0: unsupported op "insert". Legacy format was removed; use op/pos/end/lines.',
    )
  })
})

describe("line reference validation", () => {
  const lines = ["const a = 1", "const b = 2", "", "    ", "console.log(a)"]

  test("accepts current and legacy hashes", () => {
    expect(() => validateLineRef(lines, ref(1, lines[0] ?? ""))).not.toThrow()
    const legacy = `1#${computeLegacyLineHash(1, lines[0] ?? "")}`
    expect(() => validateLineRef(lines, legacy)).not.toThrow()
  })

  test("rejects stale hashes with remaps and changed-line context", () => {
    const stale = "1#ZZ"
    let error: HashlineMismatchError | undefined
    try {
      validateLineRef(lines, stale)
    } catch (caught) {
      error = caught instanceof HashlineMismatchError ? caught : undefined
    }
    expect(error).toBeInstanceOf(HashlineMismatchError)
    const message = error?.message ?? ""
    expect(message).toContain("1 line has changed since last read")
    expect(message).toContain(">>> ")
    expect(message).toContain(`1#${computeLineHash(1, lines[0] ?? "")}|const a = 1`)
    expect(error?.remaps.get(stale)).toBe(ref(1, lines[0] ?? ""))
  })

  test("rejects out-of-bounds references", () => {
    expect(() => validateLineRef(lines, "99#ZZ")).toThrow(
      "Line number 99 out of bounds. File has 5 lines.",
    )
  })

  test("rejects malformed references", () => {
    expect(() => parseLineRef("foo#VK")).toThrow(
      'Invalid line reference: "foo#VK". "foo" is not a line number. Use the actual line number from the read output.',
    )
    expect(() => parseLineRef("abc")).toThrow(
      'Invalid line reference format: "abc". Expected format: "{line_number}#{hash_id}"',
    )
  })

  test("normalizes decorated references", () => {
    expect(normalizeLineRef(`  >>> ${ref(3, "x")}|tail `)).toBe(ref(3, "x"))
    expect(normalizeLineRef("3 # AB")).toBe("3#AB")
    expect(normalizeLineRef("+ 4#CD")).toBe("4#CD")
  })

  test("suggests the line that still carries a hash", () => {
    const wanted = computeLineHash(2, lines[1] ?? "")
    expect(suggestLineForHash(lines, `8#${wanted}`)).toBe(ref(2, lines[1] ?? ""))
    expect(suggestLineForHash(lines, "8#QQ")).toBeUndefined()
  })
})

describe("hashline edits", () => {
  const lines = ["const a = 1", "const b = 2", "const c = 3", "    const d = 4"]
  const r = (n: number) => ref(n, lines[n - 1] ?? "")

  test("replaces a single anchored line", () => {
    const result = applyHashlineEdits(
      lines,
      normalizeEdits([{ op: "replace", pos: r(2), lines: ["const bb = 2"] }]),
    )
    expect(result).toEqual(["const a = 1", "const bb = 2", "const c = 3", "    const d = 4"])
  })

  test("replaces a range and deletes with null lines", () => {
    const ranged = applyHashlineEdits(
      lines,
      normalizeEdits([{ op: "replace", pos: r(1), end: r(2), lines: ["x", "y"] }]),
    )
    expect(ranged).toEqual(["x", "y", "const c = 3", "    const d = 4"])
    const deleted = applyHashlineEdits(
      lines,
      normalizeEdits([{ op: "replace", pos: r(2), lines: null }]),
    )
    expect(deleted).toEqual(["const a = 1", "const c = 3", "    const d = 4"])
  })

  test("appends after an anchor and at EOF, prepends before an anchor and at BOF", () => {
    const after = applyHashlineEdits(
      lines,
      normalizeEdits([{ op: "append", pos: r(2), lines: ["inserted"] }]),
    )
    expect(after).toEqual([
      "const a = 1",
      "const b = 2",
      "inserted",
      "const c = 3",
      "    const d = 4",
    ])
    const eof = applyHashlineEdits(lines, normalizeEdits([{ op: "append", lines: ["tail"] }]))
    expect(eof.at(-1)).toBe("tail")
    const before = applyHashlineEdits(
      lines,
      normalizeEdits([{ op: "prepend", pos: r(3), lines: ["before c"] }]),
    )
    expect(before).toEqual([
      "const a = 1",
      "const b = 2",
      "before c",
      "const c = 3",
      "    const d = 4",
    ])
    const bof = applyHashlineEdits(lines, normalizeEdits([{ op: "prepend", lines: ["head"] }]))
    expect(bof[0]).toBe("head")
  })

  test("applies multiple edits bottom-up regardless of submission order", () => {
    const result = applyHashlineEdits(
      lines,
      normalizeEdits([
        { op: "replace", pos: r(1), lines: ["A"] },
        { op: "replace", pos: r(3), lines: ["C"] },
        { op: "append", pos: r(4), lines: ["E"] },
      ]),
    )
    expect(result).toEqual(["A", "const b = 2", "C", "    const d = 4", "E"])
  })

  test("deduplicates identical edits", () => {
    const result = applyHashlineEdits(
      lines,
      normalizeEdits([
        { op: "replace", pos: r(2), lines: ["same"] },
        { op: "replace", pos: r(2), lines: ["same"] },
      ]),
    )
    expect(result).toEqual(["const a = 1", "same", "const c = 3", "    const d = 4"])
  })

  test("rejects overlapping ranges", () => {
    expect(() =>
      applyHashlineEdits(
        lines,
        normalizeEdits([
          { op: "replace", pos: r(1), end: r(3), lines: ["x"] },
          { op: "replace", pos: r(2), lines: ["y"] },
        ]),
      ),
    ).toThrow(/overlap/i)
  })

  test("rejects stale anchors before applying anything", () => {
    expect(() =>
      applyHashlineEdits(lines, normalizeEdits([{ op: "replace", pos: "1#ZZ", lines: ["x"] }])),
    ).toThrow(HashlineMismatchError)
  })

  test("restores indentation onto blank replacement lines", () => {
    const result = applyHashlineEdits(
      lines,
      normalizeEdits([{ op: "replace", pos: r(4), lines: [""] }]),
    )
    expect(result).toEqual(["const a = 1", "const b = 2", "const c = 3", "    "])
  })
})
