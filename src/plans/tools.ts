import type { Plugin } from "@opencode/plugin"
import type { Evidence, ModelRef, Plan, PlanStepInput, Route, RunHandle } from "../contracts"

type Context = Plugin.Context
type InputSchema = Awaited<ReturnType<Context["tool"]["list"]>>[number]["input"]
export type TaskInput = {
  taskID: string
  prompt: string
  route: Route
  skills?: string[]
  background?: boolean
  sessionID?: string
  explicitModel?: ModelRef
  planID?: string
  stepID?: string
  files?: string[]
}
export type RuntimeServices = {
  delegate(parentID: string, input: TaskInput, signal: AbortSignal): Promise<RunHandle>
  batch(parentID: string, inputs: TaskInput[], signal: AbortSignal): Promise<RunHandle[]>
  create(parentID: string, id: string, steps: PlanStepInput[]): Promise<Plan>
  status(parentID: string): Promise<unknown>
  compact(parentID: string, sessionID?: string): Promise<unknown>
  cancel(parentID: string, planID?: string): Promise<unknown>
  resume(parentID: string, planID: string, stepID?: string): Promise<unknown>
  verify(
    parentID: string,
    planID: string,
    stepID: string,
    evidence: Evidence[],
    waiver?: string,
  ): Promise<Plan>
}
const string = { type: "string", minLength: 1 } as const
/** Payload returned by tool handlers: JSON output plus optional host metadata. */
type ToolPayload = { output: unknown; metadata?: Record<string, unknown> }
/** Progress updates surface live child state to the host TUI (ADR-0015). */
type ProgressReport = (update: Record<string, unknown>) => Promise<void>

function childStatus(handle: RunHandle): "running" | "completed" | "error" {
  return handle.state === "completed"
    ? "completed"
    : handle.state === "running"
      ? "running"
      : "error"
}

const taskSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskID: string,
    prompt: string,
    route: {
      type: "object",
      properties: { kind: { enum: ["agent", "category"] }, id: string },
      required: ["kind", "id"],
      additionalProperties: false,
    },
    skills: { type: "array", items: string },
    background: { type: "boolean", default: true },
    sessionID: string,
    explicitModel: {
      type: "object",
      properties: { providerID: string, modelID: string, variant: string },
      required: ["providerID", "modelID"],
      additionalProperties: false,
    },
    planID: string,
    stepID: string,
    files: { type: "array", items: string },
  },
  required: ["taskID", "prompt", "route"],
} as const
export async function registerPlanTools(ctx: Context, runtime: RuntimeServices) {
  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "omo",
      description: "Persistent planning, parallel delegation, status and verification",
    })
    const add = (
      name: string,
      description: string,
      input: InputSchema,
      execute: (
        input: unknown,
        parentID: string,
        signal: AbortSignal,
        progress: ProgressReport,
      ) => Promise<ToolPayload>,
      permission?: string,
    ) => {
      if (editor.get(`omo_${name}`)) throw new Error(`tool collision: omo_${name}`)
      editor.add({
        name,
        description,
        input,
        output: {},
        options: { namespace: "omo", ...(permission ? { permission } : {}) },
        async execute(input, context) {
          const payload = await execute(input, context.sessionID, context.signal, (update) =>
            context.progress(update).catch(() => Promise.resolve()),
          )
          // The structured payload must be JSON, not merely JSON-serializable.
          // Optional fields otherwise retain undefined and fail host validation.
          const content = JSON.stringify(payload.output)
          if (content === undefined) throw new Error("omo tool returned no JSON output")
          return {
            output: JSON.parse(content),
            content,
            ...(payload.metadata ? { metadata: payload.metadata } : {}),
          }
        },
      })
    }
    add(
      "delegate",
      [
        "Delegate ONE bounded task to a specialist subagent instead of doing that work yourself.",
        "Prefer this over direct action whenever the task is independent and a specialist exists",
        "(explore: read-only codebase investigation, librarian: external docs research,",
        "executor/sisyphus-junior: implementation, reviewer/verifier: checks, oracle: advice).",
        "The prompt must contain a concrete question or owned file scope and an observable exit",
        "criterion. Default background=true returns once the child is admitted: tell the user what",
        "you delegated, END your turn, and the result arrives as a completion notification; never",
        "poll for it. Use background=false only for short gating work you need before continuing.",
        "Pass sessionID to continue that child with a follow-up prompt. Skills are attached",
        "automatically; supply planID/stepID to track step verification.",
      ].join("\n"),
      taskSchema,
      async (input, parent, signal, progress) => {
        const handle = await runtime.delegate(parent, input as TaskInput, signal)
        await progress({ sessionID: handle.sessionID, status: childStatus(handle) })
        return { output: handle, metadata: { sessionID: handle.sessionID } }
      },
      "subagent",
    )
    add(
      "parallel",
      [
        "Run 2-5 INDEPENDENT specialist tasks concurrently (up to three active children).",
        "Batch independent read-only research or exploration here instead of running one",
        "omo_delegate at a time - and instead of performing those searches yourself.",
        "Each task needs the same prompt quality as omo_delegate: concrete question, owned",
        "scope, observable exit criterion. Write tasks must declare disjoint files; tasks must",
        "not depend on each other. Returns admitted handles; results arrive as completion",
        "notifications, so tell the user what you delegated and END your turn - never poll.",
      ].join("\n"),
      {
        type: "object",
        properties: { tasks: { type: "array", minItems: 2, items: taskSchema } },
        required: ["tasks"],
        additionalProperties: false,
      },
      async (input, parent, signal, progress) => {
        const handles = await runtime.batch(parent, (input as { tasks: TaskInput[] }).tasks, signal)
        for (const handle of handles)
          await progress({ sessionID: handle.sessionID, status: childStatus(handle) })
        return {
          output: handles,
          metadata: {
            sessionID: handles[0]?.sessionID,
            sessionIDs: handles.map((handle) => handle.sessionID),
          },
        }
      },
      "subagent",
    )
    add(
      "consult",
      [
        "Ask a read-only specialist and get the finding back without expanding scope.",
        "explore investigates this codebase; librarian researches external documentation",
        "and primary sources. Use this INSTEAD of fetching URLs or searching files yourself",
        "whenever the answer is not already in your context - that duplication wastes your",
        "turn and hides the evidence trail. Only explore and librarian may be targeted.",
        "State the exact question and the evidence format you expect. Background behavior",
        "matches omo_delegate: report the consultation, end the turn, await the notification.",
      ].join("\n"),
      {
        type: "object",
        additionalProperties: false,
        properties: {
          taskID: string,
          prompt: string,
          route: {
            type: "object",
            properties: {
              kind: { const: "agent" },
              id: { enum: ["explore", "librarian"] },
            },
            required: ["kind", "id"],
            additionalProperties: false,
          },
          skills: { type: "array", items: string },
          background: { type: "boolean", default: true },
          explicitModel: {
            type: "object",
            properties: { providerID: string, modelID: string, variant: string },
            required: ["providerID", "modelID"],
            additionalProperties: false,
          },
          files: { type: "array", items: string },
        },
        required: ["taskID", "prompt", "route"],
      } as const,
      async (input, parent, signal, progress) => {
        const handle = await runtime.delegate(
          parent,
          { ...(input as TaskInput), background: (input as TaskInput).background ?? true },
          signal,
        )
        await progress({ sessionID: handle.sessionID, status: childStatus(handle) })
        return { output: handle, metadata: { sessionID: handle.sessionID } }
      },
      "consult",
    )
    add(
      "status",
      "Inspect persisted plans, attempts and recovery blockers for this parent. Call this before re-delegating after a failure and whenever a delegation seems stuck; it shows active, queued and blocked children with their native session ids.",
      { type: "object", properties: {}, additionalProperties: false },
      async (_input, parent) => ({ output: await runtime.status(parent) }),
    )
    add(
      "compact",
      "Compact this parent session through native /compact, reconcile durable state, and report remaining work. Pass sessionID only for an owned child; the parent compacts by default.",
      {
        type: "object",
        additionalProperties: false,
        properties: { sessionID: string },
      },
      async (input, parent) => ({
        output: await runtime.compact(parent, (input as { sessionID?: string }).sessionID),
      }),
    )
    add(
      "plan",
      "Create a dependency graph, resume reconciled failures, cancel owned children, or verify a finished step with evidence. Completion never follows model success alone.",
      {
        type: "object",
        additionalProperties: false,
        required: ["action", "planID"],
        properties: {
          action: { enum: ["create", "resume", "cancel", "verify"] },
          planID: string,
          stepID: string,
          waiver: string,
          steps: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "objective", "dependencies"],
              properties: {
                id: string,
                objective: string,
                dependencies: { type: "array", items: string },
              },
              additionalProperties: false,
            },
          },
          evidence: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "description"],
              properties: {
                id: string,
                description: string,
                artifact: string,
                command: string,
                exitCode: { type: "integer" },
                revision: string,
                artifactHash: string,
                origin: { enum: ["auto", "human"] },
                attemptID: string,
                reviewer: string,
              },
              additionalProperties: false,
            },
          },
        },
      },
      async (raw, parent) => {
        const input = raw as {
          action: string
          planID: string
          stepID?: string
          steps?: PlanStepInput[]
          evidence?: Evidence[]
          waiver?: string
        }
        if (input.action === "create") {
          if (!input.steps) throw new Error("steps required")
          return { output: await runtime.create(parent, input.planID, input.steps) }
        }
        if (input.action === "cancel") return { output: await runtime.cancel(parent, input.planID) }
        if (input.action === "resume")
          return { output: await runtime.resume(parent, input.planID, input.stepID) }
        if (!input.stepID) throw new Error("stepID required for verification")
        return {
          output: await runtime.verify(
            parent,
            input.planID,
            input.stepID,
            input.evidence ?? [],
            input.waiver,
          ),
        }
      },
    )
  })
}
