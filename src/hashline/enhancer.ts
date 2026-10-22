import { formatHashLine } from "./hash"

const TRUNCATION_SUFFIX = "... (line truncated to 2000 chars)"
const COLON_LINE = /^\s*(\d+): ?(.*)$/
const PIPE_LINE = /^\s*(\d+)\| ?(.*)$/
const OPEN_BLOCK = /^(<(?:content|file)>)(.*)$/
const CLOSE_BLOCK = /^\s*<\/(?:content|file)>\s*$/

type NumberedLine = { line: number; content: string }

function parseNumbered(line: string): NumberedLine | undefined {
  const match = COLON_LINE.exec(line) ?? PIPE_LINE.exec(line)
  if (!match) return undefined
  return { line: Number(match[1]), content: match[2] ?? "" }
}

/**
 * Tag a Read output with LINE#ID content hashes so hashline_edit can anchor
 * edits to the exact content the model saw. Untagged/binary output passes
 * through unchanged; truncated lines are never re-tagged. Leading human
 * headers (the live host prefixes reads with e.g. "Read file ..., lines 1-3")
 * pass through verbatim and do not stop tagging of the numbered lines below.
 */
export function transformHashlineRead(output: string): string {
  const source = output.split("\n")
  const result: string[] = []
  let inBlock = false
  let stopped = false

  for (const line of source) {
    if (!stopped && CLOSE_BLOCK.test(line)) {
      inBlock = false
      result.push(line)
      continue
    }

    const open = !stopped && !inBlock ? OPEN_BLOCK.exec(line) : null
    if (open) {
      inBlock = true
      const tag = open[1] ?? ""
      const remainder = open[2] ?? ""
      if (remainder === "") {
        result.push(line)
        continue
      }
      const parsed = parseNumbered(remainder)
      if (!parsed || parsed.content.endsWith(TRUNCATION_SUFFIX)) {
        result.push(line)
        stopped = true
        continue
      }
      result.push(`${tag}${formatHashLine(parsed.line, parsed.content)}`)
      continue
    }

    if (stopped) {
      result.push(line)
      continue
    }

    if (inBlock) {
      const parsed = parseNumbered(line)
      if (!parsed) {
        result.push(line)
        stopped = true
        continue
      }
      if (parsed.content.endsWith(TRUNCATION_SUFFIX)) {
        result.push(line)
        continue
      }
      result.push(formatHashLine(parsed.line, parsed.content))
      continue
    }

    const parsed = parseNumbered(line)
    if (!parsed) {
      result.push(line)
      continue
    }
    if (parsed.content.endsWith(TRUNCATION_SUFFIX)) {
      result.push(line)
      continue
    }
    result.push(formatHashLine(parsed.line, parsed.content))
  }

  return result.join("\n")
}
