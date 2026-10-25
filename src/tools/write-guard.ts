import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"

const MAX_TRACKED_SESSIONS = 256
const MAX_TRACKED_PATHS_PER_SESSION = 1024

type GuardArgs = {
  filePath?: string
  path?: string
  file_path?: string
  overwrite?: boolean | string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function getPathFromArgs(args: GuardArgs | undefined): string | undefined {
  return args?.filePath ?? args?.path ?? args?.file_path
}

function resolveInputPath(ctx: Plugin.Context, inputPath: string): string {
  return normalize(isAbsolute(inputPath) ? inputPath : resolve(ctx.location.directory, inputPath))
}

function isPathInsideDirectory(pathToCheck: string, directory: string): boolean {
  const relativePath = relative(directory, pathToCheck)
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}

function toCanonicalPath(absolutePath: string): string {
  let canonicalPath = absolutePath
  if (existsSync(absolutePath)) {
    try {
      canonicalPath = realpathSync(absolutePath)
    } catch {
      canonicalPath = absolutePath
    }
  } else {
    const absoluteDir = dirname(absolutePath)
    const resolvedDir = existsSync(absoluteDir) ? realpathSync(absoluteDir) : absoluteDir
    canonicalPath = join(resolvedDir, basename(absolutePath))
  }
  return normalize(canonicalPath)
}

function isOverwriteEnabled(value: boolean | string | undefined): boolean {
  if (value === true) return true
  if (typeof value === "string") return value.toLowerCase() === "true"
  return false
}

function isOmoWorkspacePath(canonicalPath: string): boolean {
  return /(^|[/\\])\.omo([/\\]|$)/.test(canonicalPath)
}

function touchSession(map: Map<string, number>, sessionID: string): void {
  map.set(sessionID, Date.now())
}

function evictLRU(sessions: Map<string, Set<string>>, lastAccess: Map<string, number>): void {
  let oldest: string | undefined
  let oldestTime = Infinity
  for (const [id, t] of lastAccess) {
    if (t < oldestTime) {
      oldest = id
      oldestTime = t
    }
  }
  if (oldest !== undefined) {
    sessions.delete(oldest)
    lastAccess.delete(oldest)
  }
}

function trimReadSet(readSet: Set<string>, max: number): void {
  while (readSet.size > max) {
    const first = readSet.values().next().value
    if (first === undefined) break
    readSet.delete(first)
  }
}

/**
 * Guard state: tracks which files each session has read, so writes to
 * existing files require a prior read in the same session.
 */
type WriteGuardState = {
  readPermissionsBySession: Map<string, Set<string>>
  sessionLastAccess: Map<string, number>
  canonicalSessionRoot: string
}

function ensureSessionReadSet(state: WriteGuardState, sessionID: string): Set<string> {
  let readSet = state.readPermissionsBySession.get(sessionID)
  if (!readSet) {
    if (state.readPermissionsBySession.size >= MAX_TRACKED_SESSIONS) {
      evictLRU(state.readPermissionsBySession, state.sessionLastAccess)
    }
    readSet = new Set<string>()
    state.readPermissionsBySession.set(sessionID, readSet)
  }
  touchSession(state.sessionLastAccess, sessionID)
  return readSet
}

function registerReadPermission(
  state: WriteGuardState,
  sessionID: string,
  canonicalPath: string,
): void {
  const readSet = ensureSessionReadSet(state, sessionID)
  readSet.delete(canonicalPath)
  readSet.add(canonicalPath)
  trimReadSet(readSet, MAX_TRACKED_PATHS_PER_SESSION)
}

function consumeReadPermission(
  state: WriteGuardState,
  sessionID: string,
  canonicalPath: string,
): boolean {
  const readSet = state.readPermissionsBySession.get(sessionID)
  if (!readSet || !readSet.has(canonicalPath)) return false
  readSet.delete(canonicalPath)
  touchSession(state.sessionLastAccess, sessionID)
  return true
}

function invalidateOtherSessions(
  state: WriteGuardState,
  canonicalPath: string,
  writingSessionID?: string,
): void {
  for (const [sessionID, readSet] of state.readPermissionsBySession.entries()) {
    if (writingSessionID && sessionID === writingSessionID) continue
    readSet.delete(canonicalPath)
  }
}

/**
 * Mount write-existing-file guard via `tool.execute.before`. Tracks reads
 * per session; writes to existing files require a prior read in the same
 * session (or an explicit `overwrite` flag, or a `.omo/**` path).
 * Default off — no hook registered unless `writeGuard` is enabled.
 */
export async function mountWriteGuard(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const state: WriteGuardState = {
    readPermissionsBySession: new Map(),
    sessionLastAccess: new Map(),
    canonicalSessionRoot: toCanonicalPath(resolveInputPath(ctx, ctx.location.directory)),
  }

  const registration = await ctx.tool.hook("execute.before", async (input) => {
    const toolName = (input.tool ?? "").toLowerCase()
    if (toolName !== "write" && toolName !== "read") return

    const argsRecord = asRecord((input as { input?: unknown }).input)
    const args = argsRecord as GuardArgs | undefined
    const filePath = getPathFromArgs(args)
    if (!filePath) return
    const resolvedPath = resolveInputPath(ctx, filePath)
    const canonicalPath = toCanonicalPath(resolvedPath)
    if (!isPathInsideDirectory(canonicalPath, state.canonicalSessionRoot)) return

    if (toolName === "read") {
      if (!existsSync(resolvedPath) || !input.sessionID) return
      registerReadPermission(state, input.sessionID, canonicalPath)
      return
    }

    const overwriteEnabled = isOverwriteEnabled(args?.overwrite)

    if (!existsSync(resolvedPath)) return
    if (isOmoWorkspacePath(canonicalPath)) {
      invalidateOtherSessions(state, canonicalPath, input.sessionID)
      return
    }
    if (overwriteEnabled) {
      invalidateOtherSessions(state, canonicalPath, input.sessionID)
      return
    }
    if (input.sessionID && consumeReadPermission(state, input.sessionID, canonicalPath)) {
      invalidateOtherSessions(state, canonicalPath, input.sessionID)
      return
    }
    throw new Error("File already exists. Use edit tool instead.")
  })

  return async () => {
    state.readPermissionsBySession.clear()
    state.sessionLastAccess.clear()
    await registration.dispose()
  }
}
