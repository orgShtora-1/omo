import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { OmoError } from "../errors/base.js"
import { collect, sha256File } from "./files"

class BackupError extends OmoError {
  constructor(
    override readonly code: "not-a-backup" | "backup-corrupt",
    detail: string,
  ) {
    super(code, `${code}: ${detail}`)
  }
}

interface BackupFileEntry {
  path: string
  sha256: string
}

export interface BackupManifest {
  version: 1
  pluginVersion: string
  createdAt: string
  files: BackupFileEntry[]
}

const toPosix = (path: string) => path.split(sep).join("/")

/**
 * Copy quiesced plugin state out of the project's state dir into `dest` with
 * a sha256 manifest. Callers must quiesce first (stop the host or unload the
 * plugin) so no SQLite handle is open mid-copy; the helper copies bytes, it
 * does not checkpoint live databases.
 */
export function backupState(
  stateDir: string,
  destDir: string,
  options: { pluginVersion?: string; now?: () => number } = {},
): BackupManifest {
  mkdirSync(destDir, { recursive: true })
  const files: BackupFileEntry[] = []
  for (const full of collect(stateDir)) {
    const rel = toPosix(relative(stateDir, full))
    const target = join(destDir, rel)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(full, target)
    files.push({ path: rel, sha256: sha256File(target) })
  }
  const manifest: BackupManifest = {
    version: 1,
    pluginVersion: options.pluginVersion ?? "unknown",
    createdAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    files,
  }
  writeFileSync(join(destDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function readManifest(backupDir: string): BackupManifest {
  let raw: string
  try {
    raw = readFileSync(join(backupDir, "manifest.json"), "utf8")
  } catch {
    throw new BackupError("not-a-backup", `${backupDir} has no manifest.json`)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new BackupError("not-a-backup", "manifest.json is not JSON")
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { version: unknown }).version !== 1 ||
    !Array.isArray((value as { files: unknown }).files) ||
    (value as { files: unknown[] }).files.some(
      (file) =>
        typeof file !== "object" ||
        file === null ||
        typeof (file as BackupFileEntry).path !== "string" ||
        !/^[0-9a-f]{64}$/.test((file as BackupFileEntry).sha256 ?? ""),
    )
  ) {
    throw new BackupError("not-a-backup", "manifest.json has an unsupported shape")
  }
  return value as BackupManifest
}

/**
 * Restore a backup into the project's state dir. Fail-closed: every backup
 * copy is hash-verified before anything is written, so a tampered backup
 * leaves live state untouched. Restored files are re-verified after copy.
 */
export function restoreState(backupDir: string, stateDir: string): BackupManifest {
  const manifest = readManifest(backupDir)
  for (const file of manifest.files) {
    if (file.path.includes("..") || file.path.startsWith("/")) {
      throw new BackupError("not-a-backup", `manifest path escapes the backup: ${file.path}`)
    }
    const copy = join(backupDir, file.path)
    if (!existsSync(copy) || sha256File(copy) !== file.sha256) {
      throw new BackupError("backup-corrupt", `backup copy failed verification: ${file.path}`)
    }
  }
  for (const file of manifest.files) {
    const target = join(stateDir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(backupDir, file.path), target)
    if (sha256File(target) !== file.sha256) {
      throw new BackupError("backup-corrupt", `restored file failed verification: ${file.path}`)
    }
  }
  rmSync(join(stateDir, "runtime.lock"), { force: true })
  return manifest
}
