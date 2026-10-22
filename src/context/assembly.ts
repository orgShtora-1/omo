import type { Plan } from "../contracts"

export interface ContextPacket {
  text: string
  artifacts: string[]
  truncated: boolean
}

/** Recovery references are mandatory; large child output is optional. No prompt history is copied. */
export function assembleContext(
  plan: Plan,
  stepID: string,
  options: { maxChars?: number; result?: string } = {},
): ContextPacket {
  const max = options.maxChars ?? 12000
  if (!Number.isSafeInteger(max) || max < 1) throw new Error("invalid-context-limit")
  const step = plan.steps.find((item) => item.id === stepID)
  if (!step) throw new Error(`unknown-step: ${stepID}`)
  const artifacts = [
    ...new Set(step.evidence.flatMap((item) => (item.artifact ? [item.artifact] : []))),
  ]
  const text = [
    `[omo recovery: ${plan.id}/${step.id}; revision ${plan.revision}]`,
    `Objective: ${step.objective}`,
    `State: ${step.state}`,
    `Dependencies: ${step.dependencies.join(", ") || "none"}`,
    `Artifacts: ${artifacts.join(", ") || "none"}`,
    "Next: resume only pending work whose dependencies are completed; verify before marking completed.",
    ...(plan.cancelledAt === undefined ? [] : ["Parent cancelled: do not readmit work."]),
  ].join("\n")
  if (text.length > max)
    throw new Error("context-too-large: mandatory recovery references exceed limit")
  if (!options.result) return { text, artifacts, truncated: false }
  const prefix = "\nChild result:\n"
  const remaining = max - text.length - prefix.length
  if (remaining < 1) return { text, artifacts, truncated: true }
  const marker = "\n[result truncated]"
  const truncated = options.result.length > remaining
  const result = truncated
    ? remaining >= marker.length
      ? options.result.slice(0, remaining - marker.length) + marker
      : options.result.slice(0, remaining)
    : options.result
  return { text: text + prefix + result, artifacts, truncated }
}
