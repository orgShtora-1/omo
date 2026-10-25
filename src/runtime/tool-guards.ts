import type { Plugin } from "@opencode/plugin"
import type { ToolGuardsConfig } from "../config/schema"
import { transformHashlineRead } from "../hashline/enhancer"
import { mountEditRecovery } from "../tools/edit-recovery"
import { mountWriteGuard } from "../tools/write-guard"

/** Maximum characters kept per tool output field before truncation. */
const OUTPUT_LIMIT = 100_000
const TRUNCATION_NOTICE = "\n[output truncated by shtora.omo tool guard]"
const JSON_HINT =
  "\n[shtora.omo: validate the payload as strict JSON and match the tool input schema before retrying]"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Truncate a string to `limit` characters, appending a visible notice. */
export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}${TRUNCATION_NOTICE}`
}

interface MutableResult {
  output?: unknown
  content?: unknown
}

function truncateValue(value: unknown, limit: number): unknown {
  if (typeof value === "string") return truncateText(value, limit)
  if (Array.isArray(value))
    return value.map((part) => {
      if (!isRecord(part)) return part
      const text = part.text
      if (typeof text === "string") return { ...part, text: truncateText(text, limit) }
      return part
    })
  return value
}

/** Mutate a completed result in place so oversized fields stay bounded. */
function guardResult(result: unknown, limit = OUTPUT_LIMIT): void {
  if (!isRecord(result)) return
  const target = result as MutableResult
  if (target.output !== undefined) target.output = truncateValue(target.output, limit)
  if (target.content !== undefined) target.content = truncateValue(target.content, limit)
}

function looksLikeJsonError(message: string): boolean {
  return /json|unexpected token|property name|unexpected end of data/i.test(message)
}

/** Append a correction hint to JSON-shaped tool errors, in place. */
function guardError(error: unknown): void {
  if (!isRecord(error)) return
  const raw = error.message
  if (typeof raw !== "string" || !looksLikeJsonError(raw)) return
  if (raw.includes("shtora.omo")) return
  error.message = `${raw}${JSON_HINT}`
}

interface AfterInput {
  readonly tool?: string
  readonly status: "completed" | "error"
  readonly result?: unknown
  readonly error?: unknown
}

function tagReadOutput(result: unknown): void {
  if (!isRecord(result)) return
  for (const field of ["output", "content"]) {
    const value = result[field]
    if (typeof value === "string") result[field] = transformHashlineRead(value)
    else if (Array.isArray(value)) {
      result[field] = value.map((part) => {
        if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part
        return { ...part, text: transformHashlineRead(part.text) }
      })
    }
  }
}

/** A native tool execute implementation: unknown in, unknown result out. */
type ToolExecute = (input: unknown, context: unknown) => Promise<unknown>

/**
 * Wrap a native read execute to tag LINE#ID hashes onto its output. Kept as
 * best-effort: earlier live probes left the native read transcript untagged,
 * but covered only `output`. V2 `content` support requires a fresh live probe;
 * those observations do not establish that the host ignores transforms.
 * Tagging already-tagged lines is a no-op, so double application is harmless.
 */
function wrapReadExecute(execute: ToolExecute): ToolExecute {
  return async (input, context) => {
    const result = await execute(input, context)
    tagReadOutput(result)
    return result
  }
}

/** Which guard list matched: write tools mutate, read tools only observe. */
type ToolGuardList = "write" | "read"

interface ToolGuardMatch {
  readonly list: ToolGuardList
  readonly tool: string
  readonly pattern: string
}

export type ToolGuardDecision =
  | { readonly verdict: "allow" }
  | { readonly verdict: "deny"; readonly reason: string; readonly match?: ToolGuardMatch }

/**
 * Exact tool name or simple trailing-"*" wildcard; a bare "*" matches every
 * tool. Config validation (parseToolGuards) already rejects "*" in any other
 * position, so only the trailing-star case is handled here.
 */
function matchesToolPattern(tool: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return tool.startsWith(pattern.slice(0, -1))
  return tool === pattern
}

/**
 * Pure write/read guard decision for one tool call, from the resolved
 * `tool_guards` option. Missing or disabled config allows everything (the
 * plugin default). With guards enabled: `write` is consulted before `read`,
 * so a tool listed in both is denied as a write; and a call without a usable
 * tool name is denied fail-closed — an unnamed call can never be proven
 * harmless.
 */
export function decideToolGuard(
  tool: unknown,
  config: ToolGuardsConfig | undefined,
): ToolGuardDecision {
  if (!config?.enabled) return { verdict: "allow" }
  if (typeof tool !== "string" || !tool.trim()) {
    return {
      verdict: "deny",
      reason: "shtora.omo tool guard: tool call without a tool name while tool_guards is enabled",
    }
  }
  for (const list of ["write", "read"] as const) {
    for (const pattern of config[list]) {
      if (!matchesToolPattern(tool, pattern)) continue
      return {
        verdict: "deny",
        match: { list, tool, pattern },
        reason: `shtora.omo tool guard: ${list} tool "${tool}" denied by pattern "${pattern}" (tool_guards.${list})`,
      }
    }
  }
  return { verdict: "allow" }
}

/**
 * Register host tool guards (output truncation + JSON error correction hint +
 * optional write/read guards) through the public V2 `tool.hook` lifecycle.
 * When `hashlineEnabled`, Read outputs are additionally tagged with LINE#ID
 * hashes (hashline pairing). Prior live probes found no anchors despite
 * hooks/transforms firing. They predated V2 `content` support and therefore
 * do not prove host mutation is ignored. Both paths are tested against the
 * public result shapes; live verification remains separate from those
 * deterministic tests. Returns a disposer for the plugin's aggregated
 * cleanup.
 */
export async function mountToolGuards(
  ctx: Plugin.Context,
  hashlineEnabled = false,
  toolGuards?: ToolGuardsConfig,
): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  // Edit error recovery: catches AI mistakes on the `edit` tool and injects
  // a recovery reminder into the output. Always-on (no config gate) — the
  // hook is cheap and only touches `edit` tool results with known error
  // patterns.
  disposers.push(await mountEditRecovery(ctx))
  // Write-existing-file guard: blocks writes to files that exist on disk
  // but haven't been read in this session. Opt-in via `write_guard.enabled`.
  if (toolGuards?.writeGuard?.enabled) {
    disposers.push(await mountWriteGuard(ctx))
  }
  const hook = await ctx.tool.hook("execute.after", (input) => {
    const after = input as AfterInput
    try {
      if (after.status === "completed") {
        guardResult(after.result)
        if (hashlineEnabled && after.tool === "read") tagReadOutput(after.result)
      } else guardError(after.error)
    } catch (error) {
      console.error("[omo] execute.after hook error:", error)
    }
  })
  // Optional write/read guards from the resolved `tool_guards` option: the
  // hook is registered only when enabled, so the default adds no hook. A
  // matched tool is denied by THROWING — fail early and loudly instead of
  // silently allowing. Whether the host turns a thrown error from this hook
  // into a hard denial is not documented for this surface (same caution as
  // the omo_team gate), and unlike that gate there is no second check inside
  // the native tool bodies, so if the host swallows hook errors a denied
  // call may still run. Unmatched tools pass untouched.
  const guard =
    toolGuards?.enabled === true
      ? await ctx.tool.hook("execute.before", async (input) => {
          const decision = decideToolGuard(input.tool, toolGuards)
          if (decision.verdict === "deny") throw new Error(decision.reason)
        })
      : undefined
  if (!hashlineEnabled) {
    return async () => {
      for (const dispose of disposers) await dispose()
      if (guard) await guard.dispose()
      await hook.dispose()
    }
  }
  const transform = await ctx.tool.transform((editor) => {
    editor.update("read", (tool) => {
      tool.execute = wrapReadExecute(tool.execute as ToolExecute) as typeof tool.execute
    })
  })
  return async () => {
    await transform.dispose()
    for (const dispose of disposers) await dispose()
    if (guard) await guard.dispose()
    await hook.dispose()
  }
}
