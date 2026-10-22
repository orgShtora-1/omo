import { readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { backupState, restoreState } from "../src/state/backup"
import { omoHome, projectStateHome } from "../src/state/home"

// Operates on quiesced state only: stop the host (or unload the plugin and
// wait for tools to settle) before backup/restore so no SQLite handle is open.
// State lives in the global OmO home (OMO_HOME or ~/.omo), one key per
// project; the <projectDir> argument identifies which project's state to act on.
const [, , command, first, second] = process.argv
function usage(): never {
  console.error("usage:")
  console.error("  bun scripts/omo-backup.ts backup <projectDir> <destDir>")
  console.error("  bun scripts/omo-backup.ts restore <backupDir> <projectDir>")
  process.exit(2)
}
if ((command !== "backup" && command !== "restore") || !first || !second) usage()
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string
}
// The project argument identifies the project; its state directory is the
// per-project key inside the global OmO home, resolved the same way the
// plugin itself resolves it at load time.
const projectState = (projectDir: string) =>
  projectStateHome(omoHome(), realpathSync(resolve(projectDir)))
try {
  const manifest =
    command === "backup"
      ? backupState(projectState(first), second, { pluginVersion: packageJson.version })
      : restoreState(first, projectState(second))
  console.log(
    `${command} ok: plugin ${manifest.pluginVersion}, ${manifest.files.length} files, manifest ${manifest.createdAt}`,
  )
  for (const file of manifest.files) console.log(`  ${file.sha256.slice(0, 12)}  ${file.path}`)
} catch (error) {
  console.error(`${command} failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
