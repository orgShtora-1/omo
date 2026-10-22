import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// Every durable file the plugin owns under its per-project state dir. SQLite
// sidecars (-wal/-shm/-journal) travel with their main file because a
// quiesced WAL database is only complete with them. runtime.lock is transient
// and is never backed up or restored.
const SQLITE_FILES = [
  "plans.sqlite",
  "runs.sqlite",
  "memory.sqlite",
  "teams.sqlite",
  "reflection-queue.sqlite",
]
const SIDECARS = ["-wal", "-shm", "-journal"]
const STATE_DIRS = ["goal", "boulder"]

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export function collect(stateDir: string): string[] {
  const found: string[] = []
  for (const name of SQLITE_FILES) {
    for (const suffix of ["", ...SIDECARS]) {
      const full = join(stateDir, `${name}${suffix}`)
      if (existsSync(full) && statSync(full).isFile()) found.push(full)
    }
  }
  for (const dir of STATE_DIRS) {
    const root = join(stateDir, dir)
    if (!existsSync(root)) continue
    const walk = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) found.push(full)
      }
    }
    walk(root)
  }
  return found.sort()
}
