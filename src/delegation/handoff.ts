import type { HandoffInput } from "../contracts.js"

class HandoffError extends Error {
  readonly code = "handoff-too-large"
  constructor(message: string) {
    super(message)
    this.name = "HandoffError"
  }
}

// Only optional background may be shortened. Required instructions and evidence
// references remain intact; callers must narrow an oversized mandatory scope.
export function buildHandoff(input: HandoffInput): string {
  const maxChars = input.maxChars ?? 12_000
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new HandoffError("maxChars must be a positive safe integer")
  }
  const section = (title: string, entries: readonly string[]) =>
    `## ${title}\n${entries.length ? entries.map((value) => `- ${value}`).join("\n") : "None supplied."}`
  const mandatory = [
    `# omo handoff: ${input.taskID}`,
    `## Objective\n${input.objective}`,
    `## Scope\n${input.scope}`,
    section("Exit criteria", input.exitCriteria),
    section("Mandatory constraints", input.constraints),
    section("Evidence references", input.evidence),
    section("Artifact references", input.artifacts),
    "## Required return\nReport Result, Evidence, Changes, and Pending. Distinguish observed evidence from assumptions; do not claim unverified completion.",
  ].join("\n\n")
  if (mandatory.length > maxChars) throw new HandoffError("mandatory handoff exceeds maxChars")
  if (!input.context) return mandatory
  const header = "\n\n## Optional context\n"
  const remaining = maxChars - mandatory.length - header.length
  if (remaining >= input.context.length) return mandatory + header + input.context
  const marker = "[context truncated]"
  if (remaining < marker.length) return mandatory
  return mandatory + header + input.context.slice(0, remaining - marker.length) + marker
}
