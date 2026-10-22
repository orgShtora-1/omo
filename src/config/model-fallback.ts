import type { Plugin } from "@opencode/plugin"
import type { ModelRef } from "../contracts"

// Fallback reativo de modelo/runtime (opção `model_fallback`) — lacuna #2 da
// auditoria de paridade. O SDK expõe `session.hook("retry")`: o host chama o
// callback com a requisição que falhou e uma `decision` mutável
// (`{ retry: false } | { retry: true, delay }` — `delay` em milissegundos,
// confirmado no `session/retry.ts` do host). Este módulo decide, de forma
// pura, o próximo candidato da cadeia configurada por perfil e o mount
// aplica: troca o modelo da sessão (`switchModel`) e assume a decisão de
// retry. Sem candidato permitido, a decisão do próprio host permanece intacta
// — o caminho de falha original nunca é engolido. Default desligado não
// registra hook nenhum: o comportamento atual fica exatamente como está.

/** Política do fallback reativo por perfil (opção `model_fallback`). */
export type ModelFallbackConfig = {
  enabled: boolean
  /** Milissegundos entregues à decisão de retry quando uma troca é aplicada. */
  delayMs: number
  /** Tentativas (contador do host) ainda elegíveis para aplicar uma troca. */
  maxAttempts: number
  /** Cadeias ordenadas por ID de perfil; cada entrada é um candidato. */
  profiles: Record<string, ModelRef[]>
}

export const DEFAULT_MODEL_FALLBACK: ModelFallbackConfig = {
  enabled: false,
  delayMs: 1_000,
  maxAttempts: 3,
  profiles: {},
}

/** Camadas de allowlist consultadas na seleção — as mesmas que o hook
 * `model.request` aplica em `assertAgentModelAllowed` (src/config/models.ts):
 * a global e a do próprio perfil, quando definidas. Estrutural, sem importar
 * `OmoOptions`, para não criar ciclo com `schema.ts` (que importa este módulo). */
export type FallbackPolicy = {
  readonly allowedModels?: ModelRef[]
  readonly profiles: ReadonlyArray<{ readonly id: string; readonly allowedModels?: ModelRef[] }>
}

/** Igualdade de modelo exata, espelhando `sameModel` (src/config/schema.ts):
 * provider, model e variante. Duplicada aqui para manter as importações em
 * sentido único (schema.ts → este módulo). */
function sameRef(a: ModelRef, b: ModelRef): boolean {
  return a.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant
}

/** Um candidato só é selecionável se passar por TODAS as camadas definidas
 * de allowlist — a global e a do perfil dono da cadeia. Camada ausente não
 * restringe. Um perfil sem allowlist próprio é regido só pela global. */
export function fallbackCandidatePermitted(
  policy: FallbackPolicy,
  profileID: string,
  model: ModelRef,
): boolean {
  const profile = policy.profiles.find((entry) => entry.id === profileID)
  const globalOk =
    policy.allowedModels === undefined || policy.allowedModels.some((c) => sameRef(c, model))
  const profileOk =
    profile?.allowedModels === undefined || profile.allowedModels.some((c) => sameRef(c, model))
  return globalOk && profileOk
}

/** A requisição que falhou, como o hook `retry` a entrega. */
export type FallbackRequest = {
  readonly agentID: string
  readonly model: ModelRef
  /** Contador de tentativa reportado pelo host (base 0 ou 1: o guard é
   * tolerante às duas leituras e limita as trocas de qualquer forma). */
  readonly attempt: number
}

/** Motivos exatos de recusa, em ordem de guarda; o caminho de falha do host
 * permanece intocado em todos eles. */
export type FallbackVerdict =
  | { action: "switch"; model: ModelRef; delayMs: number }
  | {
      action: "none"
      reason: "disabled" | "unconfigured-profile" | "attempt-cap" | "exhausted"
    }

/** Decisão pura, sem host: dada a requisição que falhou e a cadeia do perfil,
 * escolhe o próximo candidato. A cadeia avança por posição — o candidato é a
 * primeira entrada DEPOIS do modelo que falhou (ou a primeira permitida,
 * quando o modelo falho está fora da cadeia) — então o mesmo modelo nunca é
 * re-selecionado e a progressão é monotônica até esgotar. Candidatos fora das
 * allowlists são pulados, nunca selecionados; a cadeia finita mais o teto de
 * tentativas limitam as trocas por requisição. */
export function fallbackDecision(
  config: ModelFallbackConfig,
  policy: FallbackPolicy,
  request: FallbackRequest,
): FallbackVerdict {
  if (!config.enabled) return { action: "none", reason: "disabled" }
  const chain = config.profiles[request.agentID]
  if (chain === undefined || chain.length === 0)
    return { action: "none", reason: "unconfigured-profile" }
  if (request.attempt >= config.maxAttempts) return { action: "none", reason: "attempt-cap" }
  const failedAt = chain.findIndex((candidate) => sameRef(candidate, request.model))
  for (let index = failedAt + 1; index < chain.length; index++) {
    const candidate = chain[index]
    if (candidate === undefined) continue
    if (!fallbackCandidatePermitted(policy, request.agentID, candidate)) continue
    return { action: "switch", model: candidate, delayMs: config.delayMs }
  }
  return { action: "none", reason: "exhausted" }
}

/** Uma troca aplicada, publicada no seam de registro (`onSwitch`): o
 * fallback habilitado nunca é silencioso — a spec exige registro. */
export type FallbackSwitchRecord = {
  readonly sessionID: string
  readonly agentID: string
  readonly from: ModelRef
  readonly to: ModelRef
  readonly attempt: number
}

/** Dependências injetáveis do mount; o `onSwitch` registra cada troca
 * aplicada e jamais pode quebrar o caminho de retry do host. */
export type ModelFallbackDeps = {
  readonly onSwitch?: (record: FallbackSwitchRecord) => void
}

/** Registra o fallback reativo no ciclo público `session.hook("retry")`.
 * Desligado, não registra hook nenhum (o default é exatamente o comportamento
 * atual). Ligado, cada falha de modelo consulta a decisão pura; uma troca é
 * aplicada com `switchModel` ANTES de assumir a decisão — a requisição
 * repetida resolve o novo modelo da sessão — e registrada via `onSwitch`.
 * Qualquer recusa ou falha deixa a `decision` do host intocada. Nunca lança:
 * o caminho de falha original do host é o único efeito restante. */
export async function mountModelFallback(
  ctx: Plugin.Context,
  config: ModelFallbackConfig,
  policy: FallbackPolicy,
  deps: ModelFallbackDeps = {},
): Promise<() => Promise<void>> {
  if (!config.enabled) return async () => {}
  const registration = await ctx.session.hook("retry", async (input) => {
    const from: ModelRef = {
      providerID: input.model.providerID,
      modelID: input.model.id,
      ...(input.model.variant ? { variant: input.model.variant } : {}),
    }
    const verdict = fallbackDecision(config, policy, {
      agentID: input.agent,
      model: from,
      attempt: input.attempt,
    })
    if (verdict.action === "none") return
    try {
      await ctx.session.switchModel({
        sessionID: input.sessionID,
        model: {
          id: verdict.model.modelID,
          providerID: verdict.model.providerID,
          ...(verdict.model.variant ? { variant: verdict.model.variant } : {}),
        },
      })
    } catch {
      // Sem troca não há fallback: a decisão do host permanece e o erro
      // original da requisição segue seu curso.
      return
    }
    input.decision = { retry: true, delay: verdict.delayMs }
    if (deps.onSwitch)
      try {
        deps.onSwitch({
          sessionID: input.sessionID,
          agentID: input.agent,
          from,
          to: verdict.model,
          attempt: input.attempt,
        })
      } catch {
        // O registro é best-effort: nunca derruba o retry que já foi decidido.
      }
  })
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    await registration.dispose()
  }
}
