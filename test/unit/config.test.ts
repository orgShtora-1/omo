import { describe, expect, test } from "bun:test"

import { parseJSONC } from "../../src/config/jsonc"
import { assertAgentModelAllowed, validateConfiguredModels } from "../../src/config/models"
import { type ResolvedOptions, resolveOptions } from "../../src/config/resolve"
import { type OmoOptions, OptionsError, parseOptions } from "../../src/config/schema"

const example = parseJSONC(
  await Bun.file(new URL("../../examples/omo.jsonc", import.meta.url)).text(),
  "examples/omo.jsonc",
)

// T02 RED: contratos de configuração. parseOptions valida input desconhecido
// e devolve OmoOptions; resolveOptions aplica os defaults exatos da spec.
// Erros carregam `path` do campo (contrato); texto da mensagem é detalhe.

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

describe("defaults exatos da spec", () => {
  test("resolve aplica maxChildren 3, timeout 20min, retries 2/3 tentativas, fallback off, 5 skills", () => {
    const resolved: ResolvedOptions = resolveOptions(parseOptions({ schemaVersion: 1 }))
    expect(resolved.schemaVersion).toBe(1)
    expect(resolved.execution).toEqual({
      maxChildren: 3,
      timeoutMs: 20 * 60 * 1000,
      foregroundTimeoutMs: 20 * 60 * 1000,
      backgroundTimeoutMs: 20 * 60 * 1000,
      admissionTimeoutMs: 120_000,
      staleTimeoutMs: 15 * 60 * 1000,
      providerLimits: {},
      modelLimits: {},
      verifyArtifacts: false,
      maxRetries: 2,
      maxAttempts: 3,
      fallback: false,
      maxDepth: undefined,
    })
    expect(resolved.skills).toEqual({
      recommendedLimit: 5,
      auto: true,
      required: [],
      autoInstall: true,
      requireAuditPass: true,
      strictAudits: false,
    })
    expect(resolved.profiles).toEqual([])
    expect(resolved.categories).toEqual([])
  })

  test("exemplo omo.jsonc parseia e resolve com valores declarados", () => {
    const parsed: OmoOptions = parseOptions(example)
    const resolved = resolveOptions(parsed)
    expect(resolved.execution.maxChildren).toBe(3)
    expect(resolved.categories).toEqual([{ id: "investigate", agent: "planner" }])
    expect(resolved.profiles).toEqual([
      { id: "planner", mode: "subagent", allowWrite: false, model: undefined },
    ])
  })
})

describe("validação com caminho de campo", () => {
  test("execution limits, mode timeouts and artifact verification survive resolution", () => {
    const execution = resolveOptions(
      parseOptions({
        schemaVersion: 1,
        execution: {
          timeoutMs: 200,
          foregroundTimeoutMs: 100,
          backgroundTimeoutMs: 300,
          providerLimits: { p: 2 },
          modelLimits: { "p/m": 1 },
          verifyArtifacts: true,
        },
      }),
    ).execution
    expect(execution).toMatchObject({
      timeoutMs: 200,
      foregroundTimeoutMs: 100,
      backgroundTimeoutMs: 300,
      providerLimits: { p: 2 },
      modelLimits: { "p/m": 1 },
      verifyArtifacts: true,
    })
    expect(
      resolveOptions(parseOptions({ schemaVersion: 1, execution: { timeoutMs: 500 } })).execution,
    ).toMatchObject({ foregroundTimeoutMs: 500, backgroundTimeoutMs: 500 })
  })
  test("execution maps reject invalid shapes and non-positive integer entries", () => {
    for (const field of ["providerLimits", "modelLimits"]) {
      for (const value of [null, [], 1, "x"])
        expectOptionError({ schemaVersion: 1, execution: { [field]: value } }, `execution.${field}`)
      for (const value of [0, -1, 1.5, "2", undefined, null, true])
        expectOptionError(
          { schemaVersion: 1, execution: { [field]: { p: value } } },
          `execution.${field}.p`,
        )
    }
    for (const field of ["foregroundTimeoutMs", "backgroundTimeoutMs"])
      for (const value of [0, -1, 1.5, "2", null])
        expectOptionError({ schemaVersion: 1, execution: { [field]: value } }, `execution.${field}`)
    expectOptionError(
      { schemaVersion: 1, execution: { verifyArtifacts: "yes" } },
      "execution.verifyArtifacts",
    )
  })
  test("each agent has an independent exact-variant allowlist preserved for runtime selection", () => {
    const options = parseOptions({
      schemaVersion: 1,
      agents: {
        sisyphus: { model: "p/deep#high", allowedModels: ["p/deep#high", "p/fast"] },
        oracle: { allowedModels: ["p/fast"] },
      },
      profiles: [{ id: "custom", allowedModels: ["p/deep#low"] }],
    })
    const resolved = resolveOptions(options)
    expect(resolved.profiles.find((profile) => profile.id === "sisyphus")?.allowedModels).toEqual([
      { providerID: "p", modelID: "deep", variant: "high" },
      { providerID: "p", modelID: "fast" },
    ])
    expect(resolved.profiles.find((profile) => profile.id === "custom")?.allowedModels).toEqual([
      { providerID: "p", modelID: "deep", variant: "low" },
    ])
    expect(() =>
      assertAgentModelAllowed(resolved, "sisyphus", { providerID: "p", modelID: "fast" }),
    ).not.toThrow()
    expect(() =>
      assertAgentModelAllowed(resolved, "oracle", {
        providerID: "p",
        modelID: "deep",
        variant: "high",
      }),
    ).toThrow()
    expect(() =>
      assertAgentModelAllowed(resolved, "sisyphus", {
        providerID: "p",
        modelID: "deep",
        variant: "low",
      }),
    ).toThrow()
    expect(() =>
      validateConfiguredModels(options, [
        { providerID: "p", modelID: "deep", variant: "high" },
        { providerID: "p", modelID: "fast" },
      ]),
    ).toThrow("profiles[0].allowedModels[0]")
  })
  test("agent dictionaries and exact allowed model variants are validated before registration", () => {
    expectOptionError({ schemaVersion: 1, agents: { typo: { model: "p/m" } } }, "agents.typo")
    expectOptionError(
      { schemaVersion: 1, agents: { oracle: { model: "invalid" } } },
      "agents.oracle.model",
    )
    expectOptionError(
      { schemaVersion: 1, agents: { oracle: { model: "p/m#high" } }, allowedModels: ["p/m#low"] },
      "profiles[0].model",
    )
    expectOptionError(
      { schemaVersion: 1, agents: { oracle: {} }, profiles: [{ id: "oracle" }] },
      "agents.oracle",
    )
    const options = parseOptions({
      schemaVersion: 1,
      agents: { oracle: { model: "p/m#high" } },
      allowedModels: ["p/m#high"],
      categories: [{ id: "review", agent: "momus" }],
    })
    expect(options.profiles[0]?.model).toEqual({ providerID: "p", modelID: "m", variant: "high" })
    expect(resolveOptions(options).allowedModels).toEqual([
      { providerID: "p", modelID: "m", variant: "high" },
    ])
  })
  test("schemaVersion ausente, zero ou futuro são rejeitados", () => {
    expectOptionError({}, "schemaVersion")
    expectOptionError({ schemaVersion: 0 }, "schemaVersion")
    expectOptionError({ schemaVersion: 2 }, "schemaVersion")
  })

  test("input não-objeto é rejeitado na raiz", () => {
    for (const input of [null, "x", 42, []]) expectOptionError(input, "(root)")
  })

  test("campo com tipo inválido aponta o caminho", () => {
    expectOptionError(
      { schemaVersion: 1, execution: { maxChildren: "three" } },
      "execution.maxChildren",
    )
    expectOptionError({ schemaVersion: 1, execution: { fallback: "no" } }, "execution.fallback")
  })

  test("limite zero ou negativo é rejeitado", () => {
    expectOptionError({ schemaVersion: 1, execution: { maxChildren: 0 } }, "execution.maxChildren")
    expectOptionError({ schemaVersion: 1, execution: { timeoutMs: -1 } }, "execution.timeoutMs")
    expectOptionError({ schemaVersion: 1, execution: { maxRetries: -1 } }, "execution.maxRetries")
    expectOptionError({ schemaVersion: 1, execution: { maxAttempts: 0 } }, "execution.maxAttempts")
    expectOptionError(
      { schemaVersion: 1, skills: { recommendedLimit: 0 } },
      "skills.recommendedLimit",
    )
  })

  test("tentativas incompatíveis com retries são rejeitadas", () => {
    expectOptionError(
      { schemaVersion: 1, execution: { maxRetries: 2, maxAttempts: 2 } },
      "execution.maxAttempts",
    )
  })

  test("categoria desconhecida é rejeitada", () => {
    expectOptionError(
      { schemaVersion: 1, categories: [{ id: "nope", agent: "planner" }] },
      "categories[0].id",
    )
  })

  test("categoria que referencia perfil inexistente é rejeitada", () => {
    expectOptionError(
      { schemaVersion: 1, categories: [{ id: "investigate", agent: "ghost" }] },
      "categories[0].agent",
    )
  })

  test("perfil duplicado é rejeitado no segundo", () => {
    expectOptionError({ schemaVersion: 1, profiles: [{ id: "a" }, { id: "a" }] }, "profiles[1].id")
  })

  test("perfil com mode desconhecido é rejeitado", () => {
    expectOptionError(
      { schemaVersion: 1, profiles: [{ id: "a", mode: "invalid" }] },
      "profiles[0].mode",
    )
  })

  test("campo top-level desconhecido é rejeitado", () => {
    expectOptionError({ schemaVersion: 1, bogus: true }, "bogus")
  })

  test("skills autoInstall/requireAuditPass default to true and round-trip false", () => {
    const defaults = resolveOptions(parseOptions({ schemaVersion: 1 })).skills
    expect(defaults).toMatchObject({ autoInstall: true, requireAuditPass: true })
    const disabled = resolveOptions(
      parseOptions({
        schemaVersion: 1,
        skills: { autoInstall: false, requireAuditPass: false },
      }),
    ).skills
    expect(disabled).toMatchObject({ autoInstall: false, requireAuditPass: false })
    const enabled = resolveOptions(
      parseOptions({ schemaVersion: 1, skills: { autoInstall: true, requireAuditPass: true } }),
    ).skills
    expect(enabled).toMatchObject({ autoInstall: true, requireAuditPass: true })
  })

  test("skills autoInstall/requireAuditPass reject non-boolean", () => {
    expectOptionError({ schemaVersion: 1, skills: { autoInstall: "yes" } }, "skills.autoInstall")
    expectOptionError(
      { schemaVersion: 1, skills: { requireAuditPass: 1 } },
      "skills.requireAuditPass",
    )
  })
})
