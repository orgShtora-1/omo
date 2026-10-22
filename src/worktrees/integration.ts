import { runGit, WorktreeError } from "./manager"

export type IntegrationReview = { strategy: "merge"; expectedHead: string; reviewedCommit: string }
export type IntegrationResult = {
  state: "integrated" | "conflict"
  head: string
  sourceCommit: string
  conflicts: string[]
  diagnostic: string
}

/** Internal Git seam. The manager checks ownership, review and target cleanliness and reserves a durable lock first. */
export async function mergeReviewedCommit(
  repository: string,
  sourceCommit: string,
): Promise<IntegrationResult> {
  const result = await runGit(repository, [
    "merge",
    "--no-ff",
    "--no-edit",
    "--no-overwrite-ignore",
    "--",
    sourceCommit,
  ])
  const head = await runGit(repository, ["rev-parse", "HEAD"])
  if (head.exit !== 0) throw new WorktreeError("integration-uncertain", head.stderr)
  if (result.exit === 0)
    return {
      state: "integrated",
      head: head.stdout.trim(),
      sourceCommit,
      conflicts: [],
      diagnostic: result.stdout.trim(),
    }
  const mergeHead = await runGit(repository, ["rev-parse", "--verify", "MERGE_HEAD"])
  if (mergeHead.exit === 0 && mergeHead.stdout.trim() === sourceCommit) {
    const conflicts = await runGit(repository, ["diff", "--name-only", "--diff-filter=U", "-z"])
    return {
      state: "conflict",
      head: head.stdout.trim(),
      sourceCommit,
      conflicts: conflicts.stdout.split("\0").filter(Boolean),
      diagnostic: (result.stdout + result.stderr).trim(),
    }
  }
  throw new WorktreeError("integration-uncertain", (result.stdout + result.stderr).trim())
}
