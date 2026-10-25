import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { type ResolvedOptions, resolveOptions } from "../../src/config/resolve"
import { OptionsError, parseOptions } from "../../src/config/schema"
import {
  decideToolGuard,
  mountToolGuards,
  type ToolGuardDecision,
} from "../../src/runtime/tool-guards"

// Parity gap #6 (LOW-MED): write/read guards via execute.before.
// decideToolGuard é a decisão pura; o mount registra UM hook execute.before
// (apenas quando habilitado) e nega tool casada via throw. Configuração é
// estrita e fail-closed, com erros pt-BR de caminho de campo.

type HookCallback = (input: unknown) => Promise<void> | void

function expectOptionError(input: unknown, path: string): void {
  try {
    const parsed = parseOptions(input)
    resolveOptions(parsed)
  } catch (err) {
    expect(err).toBeInstanceOf(OptionsError)
    expect((err as OptionsError).path).toBe(path)
    return
  }
  throw new Error(`esperava OptionsError em ${path}, mas parseou`)
}

function denied(decision: ToolGuardDecision): Extract<ToolGuardDecision, { verdict: "deny" }> {
  if (decision.verdict !== "deny") throw new Error("esperava deny, obtive allow")
  return decision
}

function first<T>(items: readonly T[], what: string): T {
  const value = items[0]
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}

interface FakeEditor {
  get: () => undefined
  update: (id: string, update: (tool: unknown) => void) => void
}

interface GuardsFixture {
  ctx: Plugin.Context
  beforeHooks: HookCallback[]
  afterHooks: HookCallback[]
  transformed: string[]
}

function fixture(): GuardsFixture {
  const beforeHooks: HookCallback[] = []
  const afterHooks: HookCallback[] = []
  const transformed: string[] = []
  const ctx = {
    tool: {
      hook: async (name: string, callback: HookCallback) => {
        const list = name === "execute.before" ? beforeHooks : afterHooks
        list.push(callback)
        return {
          dispose: async () => {
            const at = list.indexOf(callback)
            if (at >= 0) list.splice(at, 1)
          },
        }
      },
      transform: async (callback: (editor: FakeEditor) => void) => {
        callback({
          get: () => undefined,
          update: (id: string) => {
            transformed.push(id)
          },
        })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context
  return { ctx, beforeHooks, afterHooks, transformed }
}

function beforeEvent(tool: string): { tool: string; sessionID: string; input: unknown } {
  return { tool, sessionID: "ses_test", input: {} }
}

describe("config tool_guards (strict, fail-closed)", () => {
  test("ausente: resolvido desligado com listas vazias", () => {
    const resolved: ResolvedOptions = resolveOptions(parseOptions({ schemaVersion: 1 }))
    expect(resolved.tool_guards).toEqual({ enabled: false, write: [], read: [] })
  })

  test("valores declarados parseiam e resolvem verbatim", () => {
    const declared = {
      enabled: true,
      write: ["edit", "bash", "omo_*"],
      read: ["grep", "omo_session"],
    }
    const resolved = resolveOptions(parseOptions({ schemaVersion: 1, tool_guards: declared }))
    expect(resolved.tool_guards).toEqual(declared)
  })

  test("campos opcionais: enabled sem listas resolve com listas vazias", () => {
    const resolved = resolveOptions(
      parseOptions({ schemaVersion: 1, tool_guards: { enabled: true } }),
    )
    expect(resolved.tool_guards).toEqual({ enabled: true, write: [], read: [] })
  })

  test("campo desconhecido dentro de tool_guards é rejeitado", () => {
    expectOptionError(
      { schemaVersion: 1, tool_guards: { enabled: true, surprise: true } },
      "tool_guards.surprise",
    )
  })

  test("tool_guards não-objeto é rejeitado", () => {
    for (const value of [null, 1, "x", [], true])
      expectOptionError({ schemaVersion: 1, tool_guards: value }, "tool_guards")
  })

  test("enabled não-boolean é rejeitado", () => {
    for (const value of [1, "yes", [], {}])
      expectOptionError(
        { schemaVersion: 1, tool_guards: { enabled: value } },
        "tool_guards.enabled",
      )
  })

  test("write/read não-array é rejeitado", () => {
    for (const field of ["write", "read"])
      for (const value of [null, 1, "edit", {}, true])
        expectOptionError(
          { schemaVersion: 1, tool_guards: { [field]: value } },
          `tool_guards.${field}`,
        )
  })

  test("padrões inválidos são rejeitados com caminho exato do campo", () => {
    for (const field of ["write", "read"])
      for (const value of [1, null, "", "   ", " edit", "edit ", "e*dit", "*edit", "omo**"])
        expectOptionError(
          { schemaVersion: 1, tool_guards: { [field]: [value] } },
          `tool_guards.${field}[0]`,
        )
  })

  test("padrões válidos são aceitos: nome exato, coringa final e '*' sozinho", () => {
    const resolved = resolveOptions(
      parseOptions({
        schemaVersion: 1,
        tool_guards: { enabled: true, write: ["edit", "omo_*", "*"], read: ["grep*"] },
      }),
    )
    expect(resolved.tool_guards).toEqual({
      enabled: true,
      write: ["edit", "omo_*", "*"],
      read: ["grep*"],
    })
  })
})

describe("decideToolGuard (pure decision)", () => {
  test("config ausente ou desligada permite tudo, inclusive tool listada", () => {
    expect(decideToolGuard("edit", undefined).verdict).toBe("allow")
    expect(decideToolGuard("edit", { enabled: false, write: ["edit"], read: [] }).verdict).toBe(
      "allow",
    )
  })

  test("ligado sem listas permite qualquer tool", () => {
    expect(decideToolGuard("bash", { enabled: true, write: [], read: [] }).verdict).toBe("allow")
  })

  test("negação de escrita carrega lista, padrão, tool e reason", () => {
    const decision = decideToolGuard("edit", { enabled: true, write: ["edit"], read: [] })
    const deny = denied(decision)
    expect(deny.match?.list).toBe("write")
    expect(deny.match?.tool).toBe("edit")
    expect(deny.match?.pattern).toBe("edit")
    expect(deny.reason).toContain("shtora.omo")
    expect(deny.reason).toContain('"edit"')
    expect(deny.reason).toContain("tool_guards.write")
  })

  test("negação de leitura usa a lista read", () => {
    const deny = denied(decideToolGuard("grep", { enabled: true, write: [], read: ["grep"] }))
    expect(deny.match?.list).toBe("read")
    expect(deny.reason).toContain("tool_guards.read")
  })

  test("coringa final casa por prefixo; nome exato não vaza para sufixos", () => {
    const config = { enabled: true, write: ["omo_*"], read: ["edit"] }
    expect(decideToolGuard("omo_team", config).verdict).toBe("deny")
    expect(decideToolGuard("omo", config).verdict).toBe("allow")
    expect(decideToolGuard("xomo_team", config).verdict).toBe("allow")
    expect(decideToolGuard("edit", config).verdict).toBe("deny")
    expect(decideToolGuard("edit_file", config).verdict).toBe("allow")
  })

  test("'*' sozinho casa com qualquer tool", () => {
    const config = { enabled: true, write: [], read: ["*"] }
    for (const tool of ["read", "grep", "omo_team", "bash"]) {
      const deny = denied(decideToolGuard(tool, config))
      expect(deny.match?.list).toBe("read")
      expect(deny.match?.pattern).toBe("*")
    }
  })

  test("tool presente nas duas listas é negada como escrita primeiro", () => {
    const deny = denied(
      decideToolGuard("bash", { enabled: true, write: ["bash"], read: ["bash", "grep"] }),
    )
    expect(deny.match?.list).toBe("write")
  })

  test("tool sem nome utilizável com guardas ligadas é negada fail-closed", () => {
    const config = { enabled: true, write: [], read: [] }
    for (const tool of [undefined, null, 1, "", "   ", {}]) {
      const deny = denied(decideToolGuard(tool, config))
      expect(deny.match).toBeUndefined()
      expect(deny.reason).toContain("shtora.omo")
    }
  })
})

describe("mountToolGuards denies via execute.before", () => {
  test("registra execute.before apenas quando habilitado; disposer remove", async () => {
    const enabled = fixture()
    const dispose = await mountToolGuards(enabled.ctx, false, {
      enabled: true,
      write: [],
      read: [],
    })
    expect(enabled.beforeHooks).toHaveLength(1)
    expect(enabled.afterHooks).toHaveLength(2) // edit-recovery + output-truncation
    await dispose()
    expect(enabled.beforeHooks).toHaveLength(0)
    expect(enabled.afterHooks).toHaveLength(0)
  })

  test("desligado ou ausente não registra execute.before", async () => {
    const disabled = fixture()
    await mountToolGuards(disabled.ctx, false, { enabled: false, write: ["edit"], read: [] })
    expect(disabled.beforeHooks).toHaveLength(0)
    const absent = fixture()
    // Same call shape as src/index.ts today: two arguments only.
    await mountToolGuards(absent.ctx)
    expect(absent.beforeHooks).toHaveLength(0)
  })

  test("tool casada com write ou read é negada por throw com reason da guarda", async () => {
    const { ctx, beforeHooks } = fixture()
    await mountToolGuards(ctx, false, {
      enabled: true,
      write: ["edit", "bash"],
      read: ["grep", "omo_*"],
    })
    const before = first(beforeHooks, "execute.before hook")
    await expect(before(beforeEvent("edit"))).rejects.toThrow(/tool_guards\.write/)
    await expect(before(beforeEvent("bash"))).rejects.toThrow(/tool_guards\.write/)
    await expect(before(beforeEvent("omo_team"))).rejects.toThrow(/tool_guards\.read/)
  })

  test("tool fora das listas passa sem throw", async () => {
    const { ctx, beforeHooks } = fixture()
    await mountToolGuards(ctx, false, { enabled: true, write: ["edit"], read: ["omo_*"] })
    const before = first(beforeHooks, "execute.before hook")
    await before(beforeEvent("read"))
    await before(beforeEvent("grep"))
  })

  test("hashline + guardas coexistem; disposer limpa transform, before e after", async () => {
    const { ctx, beforeHooks, afterHooks, transformed } = fixture()
    const dispose = await mountToolGuards(ctx, true, { enabled: true, write: ["edit"], read: [] })
    expect(beforeHooks).toHaveLength(1)
    expect(afterHooks).toHaveLength(2) // edit-recovery + output-truncation
    expect(transformed).toContain("read")
    await dispose()
    expect(beforeHooks).toHaveLength(0)
    expect(afterHooks).toHaveLength(0)
  })

  test("execute.after tolera erros em guardResult, tagReadOutput e guardError", async () => {
    const { ctx, afterHooks } = fixture()
    await mountToolGuards(ctx, false, { enabled: false, write: [], read: [] })
    const after = first(afterHooks, "execute.after hook")
    // Simulate a throwing guardResult - should not throw
    const throwingResult = {
      output: {
        [Symbol.iterator]: () => {
          throw new Error("boom")
        },
      },
    }
    expect(() => after({ status: "completed", result: throwingResult })).not.toThrow()
    // Simulate a normal completed result
    expect(() =>
      after({ status: "completed", tool: "read", result: { content: "ok" } }),
    ).not.toThrow()
    // Simulate a normal error result
    expect(() => after({ status: "error", error: "regular error" })).not.toThrow()
  })
})
