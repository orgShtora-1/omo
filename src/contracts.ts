// Tipos do produto @shtora/omo (não são APIs do OpenCode).

export type Route = { kind: "agent"; id: string } | { kind: "category"; id: string }

export type HandoffInput = {
  taskID: string
  objective: string
  scope: string
  exitCriteria: readonly string[]
  constraints: readonly string[]
  evidence: readonly string[]
  artifacts: readonly string[]
  context?: string
  maxChars?: number
}

export type TaskState =
  | "pending"
  | "running"
  | "verifying"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"

export type ModelRef = { providerID: string; modelID: string; variant?: string }

export type EvidenceOrigin = "auto" | "human"
export type Evidence = {
  id: string
  description: string
  artifact?: string
  /** Executed command that produced this evidence (e.g. "bun run check"). */
  command?: string
  /** Process exit code of the executed command (0 = success). */
  exitCode?: number
  /** Revision/commit identifying the code under test. */
  revision?: string
  /** Hex-encoded SHA-256 of the artifact; required whenever artifact is present. */
  artifactHash?: string
  /** How the evidence was produced. Waivers use the separate waiver field. */
  origin?: EvidenceOrigin
  /** Attempt that produced this evidence; stamped on completion when absent. */
  attemptID?: string
  /** Reviewer identity; required when origin is "human". */
  reviewer?: string
}
export type TaskAttempt = {
  attemptID: string
  sessionID: string
  parentSessionID: string
  agentID: string
  model?: ModelRef
  startedAt: number
  finishedAt?: number
  state: TaskState
}
export type PlanStepInput = {
  id: string
  objective: string
  dependencies: readonly string[]
}
export type PlanInput = {
  id: string
  projectID: string
  parentSessionID: string
  at: number
  steps: readonly PlanStepInput[]
}
export type PlanStep = PlanStepInput & {
  state: TaskState
  attempts: readonly TaskAttempt[]
  evidence: readonly Evidence[]
  waiver?: string
  reason?: string
}
export type Plan = {
  schemaVersion: 1
  id: string
  projectID: string
  parentSessionID: string
  revision: number
  createdAt: number
  updatedAt: number
  cancelledAt?: number
  steps: readonly PlanStep[]
  appliedEvents: readonly string[]
}
export type Scope = { projectID: string; locationID: string; parentSessionID: string }
export interface PlanRepository {
  load(scope: Scope, planID: string): Promise<Plan | undefined>
  save(scope: Scope, plan: Plan, expectedRevision: number | null): Promise<void>
  list(scope: Scope): Promise<readonly Plan[]>
  close(): void
}
export type PlanEvent = { id: string; at: number } & (
  | {
      type: "claim"
      stepID: string
      attempt: Omit<TaskAttempt, "state" | "startedAt" | "finishedAt">
    }
  | { type: "execution-finished"; stepID: string; attemptID: string }
  | { type: "complete"; stepID: string; evidence: readonly Evidence[]; waiver?: string }
  | { type: "block" | "fail"; stepID: string; reason: string }
  | { type: "resume" | "cancel"; stepID: string }
  | { type: "cancel-parent" }
)

export type DelegationRequest = {
  files?: readonly string[]
  projectID: string
  parentSessionID: string
  taskID: string
  route: Route
  prompt: string
  skills: string[]
  background: boolean
  sessionID?: string
  explicitModel?: ModelRef
}

export type ResolvedDelegation = {
  agentID: string
  skillReasons?: { id: string; source: "explicit" | "required" | "recommended"; score?: number }[]
  model?: ModelRef
  skills: string[]
  prompt: string
  background: boolean
  sessionID?: string
  installedSkills?: Array<{
    id: string
    source: string
    outcome: "installed" | "refused-audit" | "install-failed" | "search-empty"
  }>
}

export type RunHandle = { attemptID: string; sessionID: string; state: "running" | "completed" }

export type RunEvent = {
  attemptID: string
  sessionID: string
  state: TaskState
  eventID: string
}

export interface DelegationPolicy {
  resolve(request: DelegationRequest): ResolvedDelegation
}

export interface ExecutionAdapter {
  launch(
    request: DelegationRequest,
    resolved: ResolvedDelegation,
    signal: AbortSignal,
  ): Promise<RunHandle>
  inspect(sessionID: string): Promise<{
    state: "running" | "completed" | "failed" | "cancelled" | "unknown"
    /** Host epoch-ms of the session's last observable update, when available. */
    updatedAt?: number
  }>
  cancel(sessionID: string): Promise<void>
}
