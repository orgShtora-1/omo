/**
 * Probes that let the revision-linkage view observe a claim instead of trusting it.
 *
 * Both probes answer the same three-way question — `present`, `absent`, `unknown` —
 * and both are built so that only a positive observation produces a verdict:
 *
 * - `gitRevisionProbe` first confirms it is inside a repository at all, then asks
 *   git to resolve the revision. Only inside a repository, and only for git's
 *   dedicated "no such ref" exit status, does a failed resolution mean `absent`.
 *   Outside one, on a missing git, a timeout, a cancellation, a truncated result,
 *   an unparsable output, or any other failure exit, the answer is `unknown`: the
 *   claim is neither confirmed nor refuted.
 * - `artifactHashProbe` re-reads an artifact and hashes it. A file that hashes to
 *   the declared value is `present`, a file that hashes to something else is
 *   `absent`, and a missing, unreadable, oversized or out-of-root path is
 *   `unknown`. A deleted artifact is not proof that a recorded hash was wrong.
 *
 * Both spawn through the existing bounded seam (argv only, never a shell string)
 * and both take an injected `run`, so the whole surface is testable without a
 * repository and without touching the network.
 */

import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { Evidence } from "../contracts"
import { type BoundedOptions, type BoundedResult, ProcessError, runBounded } from "../subprocess"
import { type ProbeVerdict, SHA256_HEX } from "./revision"

/** Long enough for a cold git on Windows, short enough to never stall a tool call. */
const PROBE_TIMEOUT_MS = 5_000

/** 64MiB: an evidence artifact that is larger than this is not hashed blind. */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

type Runner = (command: string, args: string[], options?: BoundedOptions) => Promise<BoundedResult>

export interface GitRevisionProbeOptions {
  cwd?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Injected spawn seam; defaults to the runtime's bounded runner. */
  run?: Runner
}

/**
 * A revision is refused unless it looks like one: a leading alphanumeric keeps git
 * from reading it as an option, and nothing outside this shape reaches the spawn.
 * The transport is argv-only either way, so this refuses a claim the probe cannot
 * represent rather than guarding against shell injection.
 */
const REVISION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/@~^{}-]*$/
const OBJECT_ID = /^[0-9a-f]{40,64}$/

export function gitRevisionProbe(
  options: GitRevisionProbeOptions = {},
): (revision: string) => Promise<ProbeVerdict> {
  const { cwd, signal, timeoutMs = PROBE_TIMEOUT_MS, run = runBounded } = options
  // One repository check per probe: twenty evidence rows must not spawn forty git
  // processes to learn the same fact.
  let repository: Promise<boolean> | undefined
  const verdicts = new Map<string, Promise<ProbeVerdict>>()
  const ask = (args: string[]): Promise<BoundedResult> => {
    // The caller's signal is authoritative: an aborted probe spawns nothing.
    if (signal?.aborted)
      return Promise.reject(
        new ProcessError("cancelled", `git ${args[0] ?? ""} aborted before spawn`),
      )
    return run("git", args, { ...(cwd === undefined ? {} : { cwd }), timeoutMs, signal })
  }
  const insideRepository = (): Promise<boolean> => {
    repository ??= (async () => {
      try {
        const result = await ask(["rev-parse", "--git-dir"])
        return result.exit === 0
      } catch {
        return false
      }
    })()
    return repository
  }
  return (revision: string) => {
    if (signal?.aborted) return Promise.resolve("unknown")
    if (!REVISION_SHAPE.test(revision)) return Promise.resolve("unknown")
    const known = verdicts.get(revision)
    if (known) return known
    const answer = (async (): Promise<ProbeVerdict> => {
      if (!(await insideRepository())) return "unknown"
      try {
        const result = await ask(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])
        // `--quiet` reserves exit 1 for "no such ref here", which is a positive
        // observation of absence. Every other non-zero status means git failed to
        // answer — 128 for a corrupt object database, 129 for a usage mistake, a
        // negative code for a killed child — and a process that failed is not a
        // ref that is missing. Answering `absent` here would report a false
        // contradiction, so those degrade to `unknown` instead.
        if (result.exit === 1 && !result.truncated) return "absent"
        if (result.exit !== 0) return "unknown"
        // A resolved object id is the only output that can confirm a claim.
        return OBJECT_ID.test(result.stdout.trim()) ? "present" : "unknown"
      } catch {
        return "unknown"
      }
    })()
    verdicts.set(revision, answer)
    return answer
  }
}

export interface ArtifactHashProbeOptions {
  projectRoot: string
  maxBytes?: number
  signal?: AbortSignal
}

/** Containment is restated rather than imported: ./plans/verification is owned by
 * another change stream. The restatement can only be stricter here — this probe
 * reads a file to hash it and never gates a completion — so a divergence could at
 * worst skip a hash it should have taken, never accept an unverified claim. */
const outsideRoot = (root: string, path: string): boolean => {
  const remainder = relative(root, path)
  return remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)
}

export function artifactHashProbe(
  options: ArtifactHashProbeOptions,
): (item: Evidence, artifactPath: string) => Promise<ProbeVerdict> {
  const { projectRoot, maxBytes = MAX_ARTIFACT_BYTES, signal } = options
  const root = resolve(projectRoot)
  return async (item, artifactPath) => {
    if (signal?.aborted) return "unknown"
    const declared = item.artifactHash
    if (declared === undefined || !SHA256_HEX.test(declared)) return "unknown"
    try {
      const target = resolve(root, artifactPath)
      if (outsideRoot(root, target)) return "unknown"
      // Symlinks are resolved before reading so a link out of the root cannot be
      // followed, and so a link inside it is hashed as the file it points at.
      const [realRoot, realPath] = await Promise.all([realpath(root), realpath(target)])
      if (outsideRoot(realRoot, realPath)) return "unknown"
      const info = await stat(realPath)
      if (!info.isFile() || info.size > maxBytes) return "unknown"
      const digest = createHash("sha256")
        .update(await readFile(realPath))
        .digest("hex")
      return digest === declared.toLowerCase() ? "present" : "absent"
    } catch {
      return "unknown"
    }
  }
}
