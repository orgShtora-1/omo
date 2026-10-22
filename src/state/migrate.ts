import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { collect, sha256File } from "./files"

const toPosix = (path: string) => path.split(sep).join("/")

// Transient lock: it is never durable state and must never travel to the
// state home, even if a future collect() were to list it.
const RUNTIME_LOCK = "runtime.lock"
const MIGRATED_NAME = "omo.migrated"

/**
 * Legacy per-project state dir from before the global state home existed:
 * `<project>/.opencode/omo`.
 */
export function legacyStateDir(projectCanonical: string): string {
  return join(projectCanonical, ".opencode", "omo")
}

export type MigrationOutcome =
  | { status: "no-legacy" }
  | { status: "skipped-target-has-state" }
  | { status: "migrated"; copied: string[]; raced: boolean; renameFailed: boolean }
  | { status: "failed"; error: string; copied: string[] }

export interface MigrationHooks {
  beforeCopy?: (rel: string) => void
  beforeRename?: () => void
  rename?: (from: string, to: string) => void
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"

// Cleanup must never mask the failure it accompanies, so every removal is
// best-effort and confined to paths this run wrote.
const safeRm = (path: string, options: { force?: boolean; recursive?: boolean } = {}): void => {
  try {
    rmSync(path, { force: true, ...options })
  } catch {
    // best-effort
  }
}

const isEmptyDir = (path: string): boolean => {
  try {
    return readdirSync(path).length === 0
  } catch {
    return false
  }
}

/** Drop every directory created for `rels` that ended up empty, deepest first. */
function pruneEmptyDirs(root: string, rels: string[]): void {
  const dirs = new Set<string>()
  for (const rel of rels) {
    let dir = dirname(join(root, rel))
    for (;;) {
      const inside = relative(root, dir)
      if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) break
      dirs.add(dir)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    if (existsSync(dir) && isEmptyDir(dir)) safeRm(dir, { recursive: true })
  }
}

/**
 * One-shot migration from the legacy `<project>/.opencode/omo` dir into the
 * global per-project state home. Runs synchronously on the first plugin load,
 * before any consumer opens state, and is idempotent: once the legacy dir has
 * been renamed aside, later calls report "no-legacy".
 *
 * The legacy dir is never deleted, only renamed (`omo.migrated`, falling back
 * to `omo.migrated-<epoch>` when that name is taken). Every copied file is
 * sha256-verified against its source; on any copy or verification failure the
 * destination is cleaned back to exactly what this run wrote and the legacy
 * dir stays untouched for a retry. If the rename fails, the already-verified
 * destination is kept and the leftover legacy dir is left for the doctor to
 * report.
 */
export function migrateLegacyState(input: {
  projectCanonical: string
  stateHome: string
  now?: () => number
  hooks?: MigrationHooks
}): MigrationOutcome {
  const { projectCanonical, stateHome, now, hooks } = input
  const legacy = legacyStateDir(projectCanonical)
  if (!existsSync(legacy)) return { status: "no-legacy" }
  // Durable state already at the destination wins; the legacy dir stays put.
  if (collect(stateHome).length > 0) return { status: "skipped-target-has-state" }

  const copied: string[] = []
  const fail = (error: string): MigrationOutcome => {
    for (const rel of copied) safeRm(join(stateHome, rel))
    pruneEmptyDirs(stateHome, copied)
    if (existsSync(stateHome) && isEmptyDir(stateHome)) {
      safeRm(stateHome, { recursive: true })
    }
    return { status: "failed", error, copied }
  }

  const durable = collect(legacy)
    .map((full) => toPosix(relative(legacy, full)))
    .filter((rel) => rel !== RUNTIME_LOCK)

  mkdirSync(stateHome, { recursive: true })
  for (const rel of durable) {
    const source = join(legacy, rel)
    const target = join(stateHome, rel)
    try {
      hooks?.beforeCopy?.(rel)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target)
    } catch (error) {
      // The failing item never entered `copied`, but its partial bytes are
      // ours, so drop them before cleaning what did copy.
      safeRm(target)
      return fail(`copy failed for ${rel}: ${describeError(error)}`)
    }
    copied.push(rel)
  }

  for (const rel of copied) {
    let sourceHash: string
    let targetHash: string
    try {
      sourceHash = sha256File(join(legacy, rel))
      targetHash = sha256File(join(stateHome, rel))
    } catch (error) {
      return fail(`verification failed for ${rel}: ${describeError(error)}`)
    }
    if (sourceHash !== targetHash) {
      return fail(`sha256 mismatch after copy: ${rel} (legacy ${sourceHash}, target ${targetHash})`)
    }
  }

  const parent = dirname(legacy)
  let migratedDir = join(parent, MIGRATED_NAME)
  if (existsSync(migratedDir)) {
    migratedDir = join(parent, `${MIGRATED_NAME}-${now?.() ?? Date.now()}`)
  }
  hooks?.beforeRename?.()
  const doRename = hooks?.rename ?? ((from: string, to: string) => renameSync(from, to))
  try {
    doRename(legacy, migratedDir)
  } catch (error) {
    if (isEnoent(error)) {
      // Another instance migrated first; our verified destination is valid.
      return { status: "migrated", copied, raced: true, renameFailed: false }
    }
    // Destination verified and valid; keep it and leave the legacy dir in
    // place for the doctor to report.
    return { status: "migrated", copied, raced: false, renameFailed: true }
  }
  return { status: "migrated", copied, raced: false, renameFailed: false }
}
