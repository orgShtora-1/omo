import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import {
  type CommandSummary,
  createCommandService,
  mountSlashCommands,
  parseCommandName,
  resolveCommandName,
  type SlashCommandDeps,
} from "../../src/slashcommands/tools"

// Gap #7 (auto-slash + discovery de .opencode/commands): o host descobre os
// comandos do projeto e expõe o registro via ctx.command.list; o modelo não
// tem superfície nativa para listar nem invocar. Os testes cobrem a decisão
// pura (parse/resolução fail-closed), o serviço injetável e o mount.

const REGISTRY: CommandSummary[] = [
  { name: "review", description: "Review changes" },
  { name: "deep-ini" },
  { name: "team/review", description: "Nested command" },
]

function fakeDeps(commands: readonly CommandSummary[], invoked: string[] = []): SlashCommandDeps {
  return {
    listCommands: async () => commands,
    invokeCommand: async (input) => {
      invoked.push(`${input.name}|${input.text}`)
    },
  }
}

test("parseCommandName aceita nome com ou sem barra inicial e ignora espaços nas bordas", () => {
  expect(parseCommandName("/review")).toBe("review")
  expect(parseCommandName("review")).toBe("review")
  expect(parseCommandName("  team/review  ")).toBe("team/review")
})

test("parseCommandName falha fechado para nomes inválidos", () => {
  expect(() => parseCommandName("")).toThrow("nome de comando vazio")
  expect(() => parseCommandName("   ")).toThrow("nome de comando vazio")
  expect(() => parseCommandName("/")).toThrow("nome de comando vazio")
  expect(() => parseCommandName("//review")).toThrow("nome de comando vazio")
  expect(() => parseCommandName("re view")).toThrow("espaços não são permitidos")
  expect(() => parseCommandName("review\0")).toThrow("caracteres de controle")
  expect(() => parseCommandName("a".repeat(101))).toThrow("excede 100 caracteres")
  expect(() => parseCommandName(undefined)).toThrow("esperava nome de comando como texto")
  expect(() => parseCommandName(42)).toThrow("esperava nome de comando como texto")
})

test("resolveCommandName casa exatamente, resolve caixa única e falha fechado no resto", () => {
  expect(resolveCommandName(REGISTRY, "review")).toBe("review")
  expect(resolveCommandName(REGISTRY, "Review")).toBe("review")
  expect(() => resolveCommandName(REGISTRY, "missing")).toThrow(
    'comando não encontrado: missing; use action "list"',
  )
  expect(() => resolveCommandName([{ name: "Review" }, { name: "review" }], "REVIEW")).toThrow(
    "comando ambíguo: REVIEW",
  )
})

test("list devolve o registro ordenado, somente leitura e nunca invoca", async () => {
  const invoked: string[] = []
  const service = createCommandService(fakeDeps(REGISTRY, invoked))
  const output = await service.list()
  expect(output.commands.map((command) => command.name)).toEqual([
    "deep-ini",
    "review",
    "team/review",
  ])
  expect(output.commands[0]).toEqual({ name: "deep-ini" })
  expect(output.commands[2]).toEqual({ name: "team/review", description: "Nested command" })
  expect(invoked).toEqual([])
})

test("list com registro vazio é uma observação válida, não um erro", async () => {
  const service = createCommandService(fakeDeps([]))
  expect(await service.list()).toEqual({ commands: [] })
})

test("run invoca com a grafia registrada, argumentos e sessão do chamador", async () => {
  const invoked: string[] = []
  const service = createCommandService(fakeDeps(REGISTRY, invoked))
  const output = await service.run({ sessionID: "s1", name: "/Review", text: "src/a.ts" })
  expect(invoked).toEqual(["review|src/a.ts"])
  expect(output).toEqual({ invoked: "review", text: "src/a.ts" })
})

test("run sem text entrega string vazia ao comando", async () => {
  const invoked: string[] = []
  const service = createCommandService(fakeDeps(REGISTRY, invoked))
  const output = await service.run({ sessionID: "s1", name: "deep-ini", text: undefined })
  expect(invoked).toEqual(["deep-ini|"])
  expect(output).toEqual({ invoked: "deep-ini", text: "" })
})

test("run falha fechado em comando desconhecido e nunca invoca", async () => {
  const invoked: string[] = []
  const service = createCommandService(fakeDeps(REGISTRY, invoked))
  await expect(service.run({ sessionID: "s1", name: "missing", text: "" })).rejects.toThrow(
    'comando não encontrado: missing; use action "list"',
  )
  expect(invoked).toEqual([])
})

test("run falha fechado em nome inválido antes de tocar o registro", async () => {
  const invoked: string[] = []
  const service = createCommandService(fakeDeps(REGISTRY, invoked))
  await expect(service.run({ sessionID: "s1", name: "re view", text: "" })).rejects.toThrow(
    "espaços não são permitidos",
  )
  expect(invoked).toEqual([])
})

test("run rejeita text não-string e acima do limite, sem invocar", async () => {
  const invoked: string[] = []
  const service = createCommandService(fakeDeps(REGISTRY, invoked))
  await expect(service.run({ sessionID: "s1", name: "review", text: 7 })).rejects.toThrow(
    "esperava text como texto",
  )
  await expect(
    service.run({ sessionID: "s1", name: "review", text: "x".repeat(8001) }),
  ).rejects.toThrow("text excede 8000 caracteres")
  expect(invoked).toEqual([])
})

test("run propaga falha do registro (fail-closed), sem invocar", async () => {
  const invoked: string[] = []
  const deps: SlashCommandDeps = {
    listCommands: async () => {
      throw new Error("registry unavailable")
    },
    invokeCommand: async (input) => {
      invoked.push(`${input.name}|${input.text}`)
    },
  }
  await expect(
    createCommandService(deps).run({ sessionID: "s1", name: "review", text: "" }),
  ).rejects.toThrow("registry unavailable")
  expect(invoked).toEqual([])
})

interface FakeToolDefinition {
  name: string
  description: string
  options: { namespace: string; permission: string }
  output: Record<string, unknown>
  input: Record<string, unknown>
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>
}

interface CommandHarness {
  ctx: Plugin.Context
  definitions: () => FakeToolDefinition[]
  collide: (name: string) => void
  removed: () => number
  invoked: () => string[]
}

function commandHarness(commands: readonly CommandSummary[]): CommandHarness {
  let definitions: FakeToolDefinition[] = []
  const existing: Record<string, boolean> = {}
  let removed = 0
  const invoked: string[] = []
  const ctx = {
    tool: {
      transform: async (callback: (editor: unknown) => Promise<void> | void) => {
        const editor = {
          namespace: (_definition: { name: string }) => {},
          get: (name: string) => existing[name] ?? null,
          add: (definition: FakeToolDefinition) => {
            definitions.push(definition)
          },
        }
        await callback(editor)
        return {
          dispose: async () => {
            definitions = []
            removed++
          },
        }
      },
    },
    command: {
      list: async () => ({ data: commands }),
    },
    session: {
      command: async (input: { name: string; text: string }) => {
        invoked.push(`${input.name}|${input.text}`)
      },
    },
  } as unknown as Plugin.Context
  return {
    ctx,
    definitions: () => definitions,
    collide: (name: string) => {
      existing[name] = true
    },
    removed: () => removed,
    invoked: () => invoked,
  }
}

test("mount desligado não registra nada e o disposer é no-op", async () => {
  const harness = commandHarness(REGISTRY)
  const dispose = await mountSlashCommands(harness.ctx, false)
  expect(harness.definitions()).toEqual([])
  await dispose()
  expect(harness.removed()).toBe(0)
})

test("mount ligado registra omo_command no namespace omo com permissão shell", async () => {
  const harness = commandHarness(REGISTRY)
  const dispose = await mountSlashCommands(harness.ctx, true)
  const definitions = harness.definitions()
  expect(definitions.length).toBe(1)
  const definition = definitions[0]
  if (!definition) throw new Error("command tool was not registered")
  expect(definition.name).toBe("command")
  expect(definition.options).toEqual({ namespace: "omo", permission: "shell" })
  expect(definition.input.required).toEqual(["action"])
  await dispose()
  expect(harness.removed()).toBe(1)
  expect(harness.definitions()).toEqual([])
})

test("mount ligado recusa colisão de nome fail-closed", async () => {
  const harness = commandHarness(REGISTRY)
  harness.collide("omo_command")
  await expect(mountSlashCommands(harness.ctx, true)).rejects.toThrow(
    "command tool collision: omo_command",
  )
})

test("a ferramenta montada executa list e run pelo registro do host", async () => {
  const harness = commandHarness(REGISTRY)
  const dispose = await mountSlashCommands(harness.ctx, true)
  const tool = harness.definitions()[0]
  if (!tool) throw new Error("command tool was not registered")

  const listed = await tool.execute({ action: "list" }, { sessionID: "s1" })
  expect(
    JSON.parse(listed.content).commands.map((command: CommandSummary) => command.name),
  ).toEqual(["deep-ini", "review", "team/review"])
  expect(harness.invoked()).toEqual([])

  const run = await tool.execute(
    { action: "run", name: "/Review", text: "--staged" },
    { sessionID: "s1" },
  )
  expect(JSON.parse(run.content)).toEqual({ invoked: "review", text: "--staged" })
  expect(harness.invoked()).toEqual(["review|--staged"])

  await expect(tool.execute({ action: "explode" }, { sessionID: "s1" })).rejects.toThrow(
    "ação desconhecida; use list ou run",
  )
  await expect(
    tool.execute({ action: "run", name: "missing" }, { sessionID: "s1" }),
  ).rejects.toThrow('comando não encontrado: missing; use action "list"')
  expect(harness.invoked()).toEqual(["review|--staged"])
  await dispose()
})
