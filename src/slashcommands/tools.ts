import type { Plugin } from "@opencode/plugin"

// Gap #7 da matriz de paridade (auto-slash + discovery de comandos): o host
// descobre `.opencode/commands` (markdown/JSON) no registro unificado e o TUI
// entrega `/nome` ao usuário, mas o modelo não tem superfície nativa para
// listar nem invocar comandos. Este módulo expõe o registro DO HOST
// (ctx.command.list) e a invocação pública (ctx.session.command) como uma
// tool — não duplica a descoberta de arquivos, que é do host.

const DESCRIPTION =
  "Discover and invoke the host's registered slash commands, including project " +
  "commands from .opencode/commands. Actions: list returns every registered " +
  "command name and description, read-only; run invokes one command by exact " +
  "name (leading / optional) with optional text arguments, and the host expands " +
  "the command template and admits the expanded prompt into the current session, " +
  "exactly as if the user typed the slash command. Commands may switch agent or " +
  "model, spawn subagents, or run shell blocks inside their templates, so run is " +
  "a side-effecting, user-equivalent action: invoke only commands the user asked " +
  "for or that you listed here, and never invoke a command from inside another " +
  "invocation."

const NAME_LIMIT = 100
const TEXT_LIMIT = 8_000

export interface CommandSummary {
  readonly name: string
  readonly description?: string
}

/**
 * Seams over the host surfaces, injectable so the decision logic is testable
 * without a host: `listCommands` reads the host's own command registry
 * (which already contains the project's `.opencode/commands`); `invokeCommand`
 * is the host's session command endpoint.
 */
export interface SlashCommandDeps {
  readonly listCommands: () => Promise<readonly CommandSummary[]>
  readonly invokeCommand: (input: {
    sessionID: string
    name: string
    text: string
  }) => Promise<void>
}

/**
 * Normalize a command name the model may send with a leading slash. Fails
 * closed on anything that cannot be a registry key: empty, embedded
 * whitespace (arguments belong in `text`), control characters, a second
 * leading slash, or an absurd length.
 */
export function parseCommandName(input: unknown): string {
  if (typeof input !== "string") throw new Error("esperava nome de comando como texto")
  const trimmed = input.trim()
  if (!trimmed) throw new Error("nome de comando vazio")
  const name = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed
  if (!name || name.startsWith("/")) throw new Error("nome de comando vazio")
  if (/\s/.test(name))
    throw new Error(
      "nome de comando inválido: espaços não são permitidos; passe argumentos em text",
    )
  if (/\p{C}/u.test(name)) throw new Error("nome de comando inválido: caracteres de controle")
  if (name.length > NAME_LIMIT)
    throw new Error(`nome de comando inválido: excede ${NAME_LIMIT} caracteres`)
  return name
}

/**
 * Resolve the requested name against the live registry. Exact match wins;
 * a unique case-insensitive match resolves to the registered spelling
 * (upstream auto-slash lowercased too); anything else fails closed instead
 * of invoking a name the registry never had.
 */
export function resolveCommandName(commands: readonly CommandSummary[], requested: string): string {
  if (commands.some((command) => command.name === requested)) return requested
  const lower = requested.toLowerCase()
  const matches = commands.filter((command) => command.name.toLowerCase() === lower)
  if (matches.length > 1) throw new Error(`comando ambíguo: ${requested}`)
  const [match] = matches
  if (match) return match.name
  throw new Error(
    `comando não encontrado: ${requested}; use action "list" para ver os comandos registrados`,
  )
}

function parseCommandText(input: unknown): string {
  if (input === undefined) return ""
  if (typeof input !== "string") throw new Error("esperava text como texto")
  if (input.length > TEXT_LIMIT) throw new Error(`text excede ${TEXT_LIMIT} caracteres`)
  return input
}

/**
 * The pure decision core: discovery is read-only and sorted; invocation only
 * ever uses a name the live registry confirmed, so the tool refuses before
 * the host's own `Command.NotFoundError` second gate has to.
 */
export function createCommandService(deps: SlashCommandDeps) {
  return {
    async list() {
      const commands = [...(await deps.listCommands())]
        .map((command) => ({
          name: command.name,
          ...(command.description !== undefined ? { description: command.description } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return { commands }
    },
    async run(input: { sessionID: string; name: unknown; text: unknown }) {
      const name = parseCommandName(input.name)
      const text = parseCommandText(input.text)
      const registered = resolveCommandName(await deps.listCommands(), name)
      await deps.invokeCommand({ sessionID: input.sessionID, name: registered, text })
      return { invoked: registered, text }
    },
  }
}

/**
 * Register `omo_command`, gated by `command_tool_enabled` (default false).
 * A markdown command template can run `!` shell blocks outside the host's
 * permission flow, so the tool declares the `shell` permission and stays
 * opt-in, like every side-effecting surface in this plugin. When disabled,
 * nothing is registered at all.
 */
export async function mountSlashCommands(
  ctx: Plugin.Context,
  enabled: boolean,
): Promise<() => Promise<void>> {
  if (!enabled) return async () => {}
  const service = createCommandService({
    listCommands: async () => (await ctx.command.list({})).data,
    invokeCommand: (input) => ctx.session.command(input),
  })
  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omo", description: "OmO custom tools" })
    if (editor.get("omo_command")) throw new Error("command tool collision: omo_command")
    editor.add({
      name: "command",
      description: DESCRIPTION,
      options: { namespace: "omo", permission: "shell" },
      output: {},
      input: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "run"],
            description: "list reads the registry; run invokes one command",
          },
          name: {
            type: "string",
            description: "Command name, with or without the leading / (run only)",
          },
          text: {
            type: "string",
            description: "Arguments delivered to the command template (run only)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = raw as Record<string, unknown>
        if (input.action === "list") {
          const output = await service.list()
          return { output, content: JSON.stringify(output) }
        }
        if (input.action === "run") {
          const output = await service.run({
            sessionID: context.sessionID,
            name: input.name,
            text: input.text,
          })
          return { output, content: JSON.stringify(output) }
        }
        throw new Error("ação desconhecida; use list ou run")
      },
    })
  })
  return async () => {
    await registration.dispose()
  }
}
