import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Windows only grants file-symlink creation to elevated processes or Developer
// Mode; without it the call fails with EPERM. Probe once at load so tests that
// need a real link can skip explicitly instead of failing on stock Windows.
// Directory junctions need no privilege and are unaffected.
const probe = (): boolean => {
  const directory = mkdtempSync(join(tmpdir(), "omo-symlink-probe-"))
  try {
    const target = join(directory, "target.txt")
    writeFileSync(target, "probe")
    symlinkSync(target, join(directory, "link.txt"))
    return true
  } catch {
    return false
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export const canCreateFileSymlink = probe()
