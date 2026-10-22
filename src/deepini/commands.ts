import type { Plugin } from "@opencode/plugin"
import { type DeepIniArgs, parseDeepIniArgs } from "./args"
import { DEEP_INI_TEMPLATE } from "./template"

export const DEEP_INI_COMMAND = "deep-ini"

/**
 * Pure and exported so the contract can be unit-tested without a host.
 *
 * Unknown placeholders are left verbatim, so a typo in the template fails a test instead of
 * silently rendering an empty string. `template` is a seam for that test only; production always
 * passes the shipped body.
 */
export function renderDeepIniTemplate(
  args: DeepIniArgs,
  template: string = DEEP_INI_TEMPLATE,
): string {
  const values: Record<string, string> = {
    root: args.root,
    mode: args.mode,
    maxDepth: String(args.maxDepth),
  }
  const rendered = template.replaceAll(/\$\{(\w+)\}/g, (match, key: string) => {
    const value = values[key]
    return value === undefined ? match : value
  })
  return args.focus
    ? `${rendered.trim()}\n\n## User focus (honor these)\n\n${args.focus}`
    : rendered.trim()
}

/**
 * Registers `/deep-ini`: an init deep enough to earn its keep on a monorepo.
 *
 * The prompt body becomes the durable user message, not a system prompt, so it is self-contained
 * and states the goal on its first line. `...input.prompt` is spread to preserve the `files`,
 * `agents` and `skills` the TUI attached.
 *
 * There is deliberately no collision guard: `CommandEditor` is add-only (no `get`), so a
 * user-defined `.opencode/commands/deep-ini.md` wins over us by design. That is the documented
 * override path, not a bug.
 */
export async function mountDeepIni(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const registration = await ctx.command.transform((editor) => {
    editor.add({
      name: DEEP_INI_COMMAND,
      description:
        "deep hierarchical AGENTS.md init [--create-new] [--update] [--dry-run] [--max-depth=N] [--root=PATH]",
      async execute(input) {
        const args = parseDeepIniArgs(input.prompt.text ?? "", ctx.location.project.canonical)
        await ctx.session.prompt({
          ...input.prompt,
          sessionID: input.sessionID,
          text: renderDeepIniTemplate(args),
          delivery: input.delivery,
        })
      },
    })
  })
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    await registration.dispose()
  }
}
