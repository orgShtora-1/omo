import { createScanner, SyntaxKind } from "typescript/unstable/ast"

function invokesHashline(input: unknown): boolean {
  if (!input || typeof input !== "object") return false
  const code = (input as { code?: unknown }).code
  if (typeof code !== "string") return false
  const scanner = createScanner(true, undefined, code)
  const tokens: Array<{ kind: SyntaxKind; value: string }> = []
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    tokens.push({ kind, value: scanner.getTokenValue() || scanner.getTokenText() })
  }
  for (let start = 0; start < tokens.length; start++) {
    if (tokens[start]?.kind !== SyntaxKind.Identifier || tokens[start]?.value !== "tools") continue
    let index = start + 1
    let valid = true
    for (const name of ["omo", "hashline_edit"]) {
      if (
        tokens[index]?.kind === SyntaxKind.DotToken &&
        tokens[index + 1]?.kind === SyntaxKind.Identifier &&
        tokens[index + 1]?.value === name
      )
        index += 2
      else if (
        tokens[index]?.kind === SyntaxKind.OpenBracketToken &&
        tokens[index + 1]?.kind === SyntaxKind.StringLiteral &&
        tokens[index + 1]?.value === name &&
        tokens[index + 2]?.kind === SyntaxKind.CloseBracketToken
      )
        index += 3
      else {
        valid = false
        break
      }
    }
    if (valid && tokens[index]?.kind === SyntaxKind.OpenParenToken) return true
  }
  return false
}

export function hashlineCalls(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return events.filter((event) => {
    if (event.type !== "tool_use") return false
    const part = event.part as { tool?: unknown; state?: { input?: unknown } } | undefined
    if (part?.tool === "omo_hashline_edit" || part?.tool === "omo.hashline_edit") return true
    if (part?.tool !== "execute") return false
    return invokesHashline(part.state?.input)
  })
}
