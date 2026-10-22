import { DEFAULT_PACKAGE_MANAGER, nonInteractiveFlags, packageRunner } from "../config/runtime.js"
import type { PackageManager } from "../config/schema.js"
import { type BoundedResult, runBounded } from "../subprocess.js"

export type InstallOutcome = "installed" | "install-failed"

export type CommandRunner = (command: string, args: string[]) => Promise<BoundedResult>

export function buildInstallArgs(source: string, slug: string): string[] {
  return ["skills", "add", source, "--skill", slug, "-y"]
}

export async function installSkill(input: {
  source: string
  slug: string
  cwd: string
  /** Package manager derived from `runtime.packageManager`; defaults to bun. */
  packageManager?: PackageManager
  run?: CommandRunner
}): Promise<InstallOutcome> {
  const args = buildInstallArgs(input.source, input.slug)
  const packageManager = input.packageManager ?? DEFAULT_PACKAGE_MANAGER
  const runner = packageRunner(packageManager)
  const run: CommandRunner =
    input.run ?? ((command, a) => runBounded(command, a, { cwd: input.cwd, timeoutMs: 120_000 }))
  try {
    const result = await run(runner.command, [
      ...runner.args,
      ...nonInteractiveFlags(packageManager),
      ...args,
    ])
    return result.exit === 0 ? "installed" : "install-failed"
  } catch {
    return "install-failed"
  }
}
