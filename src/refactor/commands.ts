import type { Plugin } from "@opencode/plugin"
import { parseRefactorArgs, type RefactorArgs } from "./args"
import { REFACTOR_TEMPLATE } from "./template"

const REFACTOR_COMMAND = "refactor"

/**
 * Pure and exported so the contract can be unit-tested without a host. Unknown placeholders survive
 * verbatim so a typo fails a test instead of rendering an empty string. `template` is a seam for that
 * test only; production always passes the shipped body.
 */
export function renderRefactorTemplate(
  args: RefactorArgs,
  template: string = REFACTOR_TEMPLATE,
): string {
  const values: Record<string, string> = {
    target: args.target,
    scope: args.scope,
    strategy: args.strategy,
    root: args.root,
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
 * Registers `/refactor`. The body becomes the durable user message, so it is self-contained and
 * states the target on its first lines.
 *
 * No collision guard, for the same reason as every other command here: `CommandEditor` is add-only,
 * so a user-defined `.opencode/commands/refactor.md` wins by design.
 */
export async function mountRefactor(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const registration = await ctx.command.transform((editor) => {
    editor.add({
      name: REFACTOR_COMMAND,
      description:
        "grounded refactor: intent gate, LSP codemap, test-coverage gate, verified every step [--scope=file|module|project] [--strategy=safe|aggressive]",
      async execute(input) {
        const args = parseRefactorArgs(input.prompt.text ?? "", ctx.location.project.canonical)
        await ctx.session.prompt({
          ...input.prompt,
          sessionID: input.sessionID,
          text: renderRefactorTemplate(args),
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
