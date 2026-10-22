import type { PackageManager } from "./schema"

/**
 * Runtime/package-manager preference for OmO (`runtime.packageManager`).
 *
 * `packageManager` is the single knob the user sets; every OmO command that
 * shells out to a package manager is derived from it. The one-off runner
 * (`npx`-style) is what the skills auto-installer and the doctor remediation
 * use today, so choosing `bun` makes OmO run `bunx`, `yarn` runs `yarn dlx`,
 * and so on. Bun stays the default because OmO is Bun-first (host and tooling
 * run under Bun); `npm` restores the previous `npx` behaviour.
 */

/** One-off package execution command (npx-style) for a package manager. */
export type RunnerSpec = { readonly command: string; readonly args: readonly string[] }

/** Package manager OmO uses when the configuration omits `runtime.packageManager`. */
export const DEFAULT_PACKAGE_MANAGER: PackageManager = "bun"

/** Map a package manager to its one-off runner (like `npx`). */
export function packageRunner(packageManager: PackageManager): RunnerSpec {
  switch (packageManager) {
    case "npm":
      return { command: "npx", args: [] }
    case "bun":
      return { command: "bunx", args: [] }
    case "yarn":
      return { command: "yarn", args: ["dlx"] }
    case "pnpm":
      return { command: "pnpm", args: ["dlx"] }
  }
}

/**
 * The npm-only non-interactive flag. `bunx`, `yarn dlx` and `pnpm dlx` install
 * without a confirmation prompt, so they must not receive it.
 */
export function nonInteractiveFlags(packageManager: PackageManager): string[] {
  return packageManager === "npm" ? ["-y"] : []
}

/**
 * The reviewed Skills MCP package, pinned exactly. A bare selector would let
 * the package runner resolve any future version; the pin keeps the running
 * tool catalog aligned with what OmO's defaults and tests were reviewed for.
 */
const SKILLS_MCP_PACKAGE = "@shtora/skills@0.1.0"

const PINNED_SKILLS_SELECTOR =
  /^@shtora\/skills@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Whether a skills command array pins an exact `@shtora/skills` version. */
export function isPinnedSkillsCommand(command: readonly string[]): boolean {
  return command.some((argument) => PINNED_SKILLS_SELECTOR.test(argument))
}

/**
 * The command array that runs the Skills MCP over stdio for the host MCP
 * configuration, e.g. `bunx @shtora/skills@0.1.0` or
 * `npx -y @shtora/skills@0.1.0`. Only npm needs `-y`: bunx, `yarn dlx` and
 * `pnpm dlx` install without a confirmation prompt.
 */
export function skillsMcpCommand(packageManager: PackageManager): string[] {
  const runner = packageRunner(packageManager)
  return [
    runner.command,
    ...runner.args,
    ...nonInteractiveFlags(packageManager),
    SKILLS_MCP_PACKAGE,
  ]
}
