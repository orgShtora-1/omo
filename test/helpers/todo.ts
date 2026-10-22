import type { Plugin } from "@opencode/plugin"

export type TodoTool = {
  name: string
  options: { namespace?: string; permission?: string }
  execute(
    input: unknown,
    context: { sessionID: string; signal: AbortSignal },
  ): Promise<{ output: unknown; content?: string }>
}
type Command = { name: string; execute(input: unknown): Promise<void> | void }

export function todoFixture(directory = "C:/todo-project", values = new Map<string, unknown>()) {
  const tools = new Map<string, TodoTool>()
  const commands: Command[] = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const identity = { projectID: "p", directory }
  let disposed = 0
  const ctx = {
    location: { directory, project: { id: "p", canonical: directory } },
    storage: {
      async get(key: string) {
        return values.get(key)
      },
      async set(key: string, value: unknown) {
        values.set(key, structuredClone(value))
      },
    },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        return {
          id: sessionID,
          projectID: identity.projectID,
          location: { directory: identity.directory },
        }
      },
      async prompt(input: { sessionID: string; text: string }) {
        prompts.push(input)
        return {}
      },
    },
    tool: {
      async transform(
        callback: (editor: {
          namespace(value: unknown): void
          get(id: string): TodoTool | undefined
          add(tool: TodoTool): void
        }) => void,
      ) {
        const added: string[] = []
        callback({
          namespace() {},
          get: (id) => tools.get(id),
          add(tool) {
            const id = `omo_${tool.name}`
            tools.set(id, tool)
            added.push(id)
          },
        })
        return {
          async dispose() {
            disposed++
            for (const id of added) tools.delete(id)
          },
        }
      },
    },
    command: {
      async transform(callback: (editor: { add(command: Command): void }) => void) {
        callback({ add: (command) => commands.push(command) })
        return { async dispose() {} }
      },
    },
  }
  return {
    ctx: ctx as unknown as Plugin.Context,
    values,
    tools,
    commands,
    prompts,
    identity,
    disposed: () => disposed,
    async call(
      name: string,
      input: unknown,
      sessionID = "s",
      signal = new AbortController().signal,
    ) {
      const tool = tools.get(`omo_${name}`)
      if (!tool) throw new Error(`missing tool ${name}`)
      return tool.execute(input, { sessionID, signal })
    },
    async handoff(sessionID = "s") {
      const command = commands.find((item) => item.name === "handoff")
      if (!command) throw new Error("missing /handoff")
      await command.execute({ prompt: { text: "" }, sessionID })
    },
  }
}
