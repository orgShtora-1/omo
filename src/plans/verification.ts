import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { Evidence, PlanStep } from "../contracts"
export type VerificationResult = { ok: boolean; reason?: string }
export type VerificationOptions = {
  verifyArtifacts?: boolean
  projectRoot?: string
  /** Current attempt; evidence bound to another attempt is rejected, unbound stamps on completion. */
  attemptID?: string
  /** Evidence IDs already accepted by other steps; reuse is rejected. */
  seenEvidenceIDs?: readonly string[]
}
const outsideRoot = (root: string, path: string) => {
  const remainder = relative(root, path)
  return remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)
}
const sha256Hex = /^[0-9a-fA-F]{64}$/

function computeSha256(filePath: string): string {
  const content = readFileSync(filePath)
  return createHash("sha256").update(content).digest("hex")
}

export function evidenceContentError(
  evidence: readonly Evidence[],
  context: Pick<VerificationOptions, "attemptID" | "seenEvidenceIDs"> = {},
): string | undefined {
  const seen = new Set<string>()
  for (const item of evidence) {
    if (seen.has(item.id)) return `Evidence ${item.id} is duplicated`
    seen.add(item.id)
    if (context.seenEvidenceIDs?.includes(item.id))
      return `Evidence ${item.id} was already used and cannot be reused for new code`
    if (!item.command?.trim()) return `Evidence ${item.id} requires the executed command`
    if (item.exitCode === undefined || !Number.isSafeInteger(item.exitCode))
      return `Evidence ${item.id} requires the exit code`
    if (!item.revision?.trim()) return `Evidence ${item.id} requires the revision/commit`
    if (item.origin !== "auto" && item.origin !== "human")
      return `Evidence ${item.id} requires origin auto|human`
    if (item.origin === "human" && !item.reviewer?.trim())
      return `Evidence ${item.id} requires a reviewer`
    if (
      context.attemptID !== undefined &&
      item.attemptID !== undefined &&
      item.attemptID !== context.attemptID
    )
      return `Evidence ${item.id} was bound to attempt ${item.attemptID}`
    if (item.artifact !== undefined) {
      if (!item.artifact.trim()) return `Evidence ${item.id} has a blank artifact path`
      if (!item.artifactHash || !sha256Hex.test(item.artifactHash))
        return `Evidence ${item.id} requires an artifact hash (sha256)`
    }
  }
  return undefined
}

export function verifyStep(
  step: PlanStep,
  evidence: readonly Evidence[],
  waiver?: string,
  options: VerificationOptions = {},
): VerificationResult {
  if (step.state !== "verifying")
    return { ok: false, reason: "Execution must finish before verification" }
  if (evidence.some((item) => !item.id.trim() || !item.description.trim()))
    return { ok: false, reason: "Evidence requires an ID and description" }
  if (!evidence.length && !waiver?.trim())
    return { ok: false, reason: "Supply evidence or an explicit justified waiver" }
  if (evidence.length) {
    const error = evidenceContentError(evidence, options)
    if (error) return { ok: false, reason: error }
  }
  if (options.verifyArtifacts) {
    for (const item of evidence) {
      if (item.artifact === undefined) continue
      if (!item.artifact.trim())
        return { ok: false, reason: `Evidence ${item.id} has a blank artifact path` }
      try {
        const root = resolve(options.projectRoot ?? process.cwd())
        const path = resolve(root, item.artifact)
        if (options.projectRoot !== undefined && outsideRoot(root, path))
          return {
            ok: false,
            reason: `Evidence ${item.id} artifact is outside project root: ${item.artifact}`,
          }
        const realPath = realpathSync(path)
        if (options.projectRoot !== undefined && outsideRoot(realpathSync(root), realPath))
          return {
            ok: false,
            reason: `Evidence ${item.id} artifact is outside project root: ${item.artifact}`,
          }
        // Verify artifact hash matches file content
        if (item.artifactHash) {
          const computedHash = computeSha256(realPath)
          if (computedHash !== item.artifactHash.toLowerCase()) {
            return {
              ok: false,
              reason: `Evidence ${item.id} artifact hash mismatch: expected ${item.artifactHash}, got ${computedHash}`,
            }
          }
        }
      } catch {
        return {
          ok: false,
          reason: `Evidence ${item.id} artifact is missing or inaccessible: ${item.artifact}`,
        }
      }
    }
  }
  return { ok: true }
}
