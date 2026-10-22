/**
 * Revision-linked evidence: what a plan's stored evidence actually claims about the
 * code it was observed on, and how far that claim was corroborated.
 *
 * The plan store already refuses evidence without a `revision`
 * (`evidenceContentError` in ../plans/verification), so a completed step always
 * states one. What it never did is tie those statements together or check them
 * against anything observable: two steps could claim different revisions and the
 * plan still read as complete. This module adds that missing view, and only that
 * view. It derives from the stored plan, writes nothing, and opens no second path
 * to completion.
 *
 * Two rules hold everywhere in here:
 *
 * - A declared revision is a caller-stated claim. It becomes `confirmed` only when
 *   an injected probe observes it; without a probe every claim stays
 *   `unverifiable`. The absence of a probe can never produce a confirmation.
 * - A probe that throws, times out, is aborted or answers unparsably is
 *   `unverifiable`, never `contradicted`. Only a probe that positively observed
 *   the claim to be false contradicts it.
 */

import type { Evidence, EvidenceOrigin, Plan } from "../contracts"

/** What an injected probe could conclude about one claim. */
export type ProbeVerdict = "present" | "absent" | "unknown"

/** What this module concluded. `unverifiable` is never a soft confirmation. */
type LinkageVerdict = "confirmed" | "contradicted" | "unverifiable"

type LinkageStatus =
  /**
   * One revision, every item declares it, every corroboration confirmed, and the
   * plan record itself was readable in full.
   */
  | "linked"
  /** One revision, every item declares it, at least one corroboration unverifiable. */
  | "asserted"
  /** Evidence exists but some of it declares no revision, or none of it does. */
  | "unlinked"
  /** Two or more distinct declared revisions. */
  | "divergent"
  /** A probe positively observed a claim to be false. */
  | "contradicted"

type Corroboration = {
  kind: "revision" | "artifact"
  /** The revision string, or the artifact path exactly as declared. */
  target: string
  verdict: LinkageVerdict
  /** Why the verdict is what it is. Absent when a probe confirmed cleanly. */
  detail?: string
}

type LinkedEvidence = {
  stepID: string
  evidenceID: string
  /** Null when the item declares no revision. */
  revision: string | null
  origin: EvidenceOrigin | "unknown"
  corroborations: readonly Corroboration[]
}

export type RevisionLinkage = {
  schemaVersion: 1
  planID: string
  /**
   * `Plan.revision` is the store's optimistic-concurrency counter, not a code
   * revision. Null when the record does not carry a readable number: an absent
   * counter is reported as absent rather than invented as zero.
   */
  planRecordRevision: number | null
  status: LinkageStatus
  /** Distinct declared revisions, sorted, so two runs cannot reorder the report. */
  revisions: readonly string[]
  items: readonly LinkedEvidence[]
  waivers: readonly { stepID: string; waiver: string }[]
  /** Every input path that could not be read, named by exact location. */
  unreadable: readonly string[]
  notes: readonly string[]
}

export interface RevisionLinkOptions {
  /** Observes whether a declared revision exists. Omitted means nothing is confirmed. */
  resolveRevision?: (revision: string) => Promise<ProbeVerdict>
  /** Observes whether an artifact still hashes to the hash its evidence declares. */
  verifyArtifact?: (item: Evidence, artifactPath: string) => Promise<ProbeVerdict>
  signal?: AbortSignal
}

/** The one shape a declared sha256 may take. Exported so the probes agree with
 * the gate this module applies before it ever asks one. */
export const SHA256_HEX = /^[0-9a-fA-F]{64}$/

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const trimmed = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const CALLER_STATED =
  "A declared revision is a caller-stated claim; this view confirms it only when a probe observed it."
const PLAN_REVISION_NOT_CODE =
  "planRecordRevision is the plan store's optimistic-concurrency counter, not a code revision."
const NO_PROBE = "no corroboration probe was supplied"

/** One evidence row as it was stored, kept beside the fields the report derives. */
type Row = {
  stepID: string
  evidenceID: string
  revision: string | null
  origin: EvidenceOrigin | "unknown"
  artifact: string | null
  artifactHash: string | undefined
  /** The original row; the artifact probe rebuilds a minimal Evidence from it. */
  raw: Record<string, unknown>
}

type Read = {
  planID: string
  /** Null when `plan.revision` is absent or not a readable number. */
  planRecordRevision: number | null
  rows: readonly Row[]
  waivers: readonly { stepID: string; waiver: string }[]
  unreadable: string[]
  /**
   * Count of rows (a malformed step, evidence list, item or revision) that could
   * not be read. The name says rows rather than revisions because a row can be
   * unreadable for reasons that have nothing to do with its revision.
   */
  unreadableRows: number
}

/**
 * Reads the stored plan defensively. A malformed or legacy row is named by path and
 * kept out of the report rather than being quietly counted as a healthy claim.
 */
function read(plan: Plan): Read {
  const unreadable: string[] = []
  const unread = (path: string, expected: string) =>
    unreadable.push(`${path}: expected ${expected}`)
  const empty = (planID: string, planRecordRevision: number | null, unlinked: number): Read => ({
    planID,
    planRecordRevision,
    rows: [],
    waivers: [],
    unreadable,
    unreadableRows: unlinked,
  })
  if (!isObject(plan)) {
    unread("plan", "an object")
    return empty("", null, 1)
  }
  const planID = trimmed(plan.id) ?? ""
  if (planID === "") unread("plan.id", "a string")
  if (typeof plan.projectID !== "string") unread("plan.projectID", "a string")
  if (typeof plan.parentSessionID !== "string") unread("plan.parentSessionID", "a string")
  const revision = plan.revision
  const planRecordRevision =
    typeof revision === "number" && Number.isFinite(revision) ? revision : null
  if (planRecordRevision === null) unread("plan.revision", "a number")
  const steps: unknown = plan.steps
  if (!Array.isArray(steps)) {
    unread("plan.steps", "an array")
    return empty(planID, planRecordRevision, 0)
  }
  const rows: Row[] = []
  const waivers: { stepID: string; waiver: string }[] = []
  let unreadableRows = 0
  steps.forEach((step, stepIndex) => {
    if (!isObject(step)) {
      unread(`steps[${stepIndex}]`, "an object")
      unreadableRows += 1
      return
    }
    const stepID = trimmed(step.id) ?? ""
    if (stepID === "") unread(`steps[${stepIndex}].id`, "a string")
    const waiver = trimmed(step.waiver)
    if (waiver !== null && stepID !== "") waivers.push({ stepID, waiver })
    const evidence: unknown = step.evidence
    if (evidence === undefined) return
    if (!Array.isArray(evidence)) {
      unread(`steps[${stepIndex}].evidence`, "an array")
      unreadableRows += 1
      return
    }
    evidence.forEach((item, index) => {
      const path = `steps[${stepIndex}].evidence[${index}]`
      if (!isObject(item)) {
        unread(path, "an object")
        unreadableRows += 1
        return
      }
      const evidenceID = trimmed(item.id) ?? ""
      if (evidenceID === "") unread(`${path}.id`, "a string")
      const declared: unknown = item.revision
      // An absent revision is a fact about the evidence; an unreadable one is a fact
      // about the row, and only the second keeps the plan out of the linked status.
      if (declared !== undefined && typeof declared !== "string") {
        unread(`${path}.revision`, "a string")
        unreadableRows += 1
        return
      }
      rows.push({
        stepID,
        evidenceID,
        revision: trimmed(declared),
        origin: item.origin === "auto" || item.origin === "human" ? item.origin : "unknown",
        artifact: trimmed(item.artifact),
        artifactHash: typeof item.artifactHash === "string" ? item.artifactHash : undefined,
        raw: item,
      })
    })
  })
  return {
    planID,
    planRecordRevision,
    rows,
    waivers,
    unreadable,
    unreadableRows,
  }
}

async function probeRevision(
  revision: string,
  options: RevisionLinkOptions,
): Promise<Corroboration> {
  const base = { kind: "revision" as const, target: revision }
  // Read here rather than accepting a snapshot from the caller: an abort raised
  // by an earlier probe must stop this one too, not just the ones after it.
  if (options.signal?.aborted)
    return { ...base, verdict: "unverifiable", detail: "aborted before the probe ran" }
  const probe = options.resolveRevision
  if (!probe) return { ...base, verdict: "unverifiable", detail: NO_PROBE }
  try {
    const verdict = await probe(revision)
    if (verdict === "present") return { ...base, verdict: "confirmed" }
    if (verdict === "absent")
      return {
        ...base,
        verdict: "contradicted",
        detail: "the repository resolved without this revision",
      }
    return { ...base, verdict: "unverifiable", detail: "the probe could not decide" }
  } catch (error) {
    return { ...base, verdict: "unverifiable", detail: `the probe failed: ${why(error)}` }
  }
}

async function probeArtifact(
  row: Row,
  options: RevisionLinkOptions,
): Promise<Corroboration | undefined> {
  // Nothing declared to corroborate is not an unverified claim: the plan store
  // only requires a hash when an artifact is named, so an artifact with no hash is
  // reported by that check, not invented into a failure here.
  if (row.artifact === null || row.artifactHash === undefined) return undefined
  const base = { kind: "artifact" as const, target: row.artifact }
  if (options.signal?.aborted)
    return { ...base, verdict: "unverifiable", detail: "aborted before the probe ran" }
  if (!SHA256_HEX.test(row.artifactHash))
    return {
      ...base,
      verdict: "unverifiable",
      detail: "the declared hash is not a sha256 hex string",
    }
  const probe = options.verifyArtifact
  if (!probe) return { ...base, verdict: "unverifiable", detail: NO_PROBE }
  const item = {
    id: row.evidenceID,
    description: typeof row.raw.description === "string" ? row.raw.description : "",
    artifact: row.artifact,
    artifactHash: row.artifactHash,
  } satisfies Evidence
  try {
    const verdict = await probe(item, row.artifact)
    if (verdict === "present") return { ...base, verdict: "confirmed" }
    if (verdict === "absent")
      return {
        ...base,
        verdict: "contradicted",
        detail: "the content no longer hashes to the declared value",
      }
    return { ...base, verdict: "unverifiable", detail: "the probe could not decide" }
  } catch (error) {
    return { ...base, verdict: "unverifiable", detail: `the probe failed: ${why(error)}` }
  }
}

/**
 * Reports which revision each stored evidence item claims, and how far each claim
 * was corroborated. `status` is a ladder, most severe first: contradicted,
 * divergent, unlinked, asserted, linked. `linked` requires one revision, declared
 * by every item, with every corroboration confirmed.
 */
export async function buildRevisionLinkage(
  plan: Plan,
  options: RevisionLinkOptions = {},
): Promise<RevisionLinkage> {
  const state = read(plan)
  const revisions = [
    ...new Set(state.rows.map((row) => row.revision).filter((it) => it !== null)),
  ].sort()
  // One probe per distinct revision, not one per row: the claim is about the revision.
  const byRevision = new Map<string, Corroboration>()
  for (const revision of revisions) byRevision.set(revision, await probeRevision(revision, options))
  const items: LinkedEvidence[] = []
  for (const row of state.rows) {
    const corroborations: Corroboration[] = []
    if (row.revision !== null) {
      const observed = byRevision.get(row.revision)
      if (observed) corroborations.push(observed)
    }
    const artifact = await probeArtifact(row, options)
    if (artifact) corroborations.push(artifact)
    items.push({
      stepID: row.stepID,
      evidenceID: row.evidenceID,
      revision: row.revision,
      origin: row.origin,
      corroborations,
    })
  }
  const contradicted = items.some((item) =>
    item.corroborations.some((entry) => entry.verdict === "contradicted"),
  )
  const unlinked = state.unreadableRows + items.filter((item) => item.revision === null).length
  const everyConfirmed =
    items.length > 0 &&
    items.every((item) => item.corroborations.length > 0) &&
    items.every((item) => item.corroborations.every((entry) => entry.verdict === "confirmed"))
  // A record that could not be read in full cannot be reported as linked: the
  // report would claim a complete picture it never had.
  const readableInFull = state.unreadable.length === 0
  const status: LinkageStatus = contradicted
    ? "contradicted"
    : revisions.length > 1
      ? "divergent"
      : unlinked > 0 || revisions.length === 0
        ? "unlinked"
        : everyConfirmed && readableInFull
          ? "linked"
          : "asserted"
  const notes: string[] = [CALLER_STATED, PLAN_REVISION_NOT_CODE]
  if (items.length === 0 && state.waivers.length === 0)
    notes.push("no evidence and no waiver were observed, so nothing is revision-linked")
  if (state.waivers.length > 0)
    notes.push(
      "a waived step is not evidence and carries no revision, so it is listed and never counted as linked",
    )
  if (!readableInFull)
    notes.push("part of the plan record could not be read, so it is never reported as linked")
  // Re-read at the end: an abort raised while a probe ran applies to this report
  // as surely as one raised before the first call.
  const aborted = options.signal?.aborted === true
  if (aborted) notes.push("the caller's signal was aborted, so no claim was corroborated")
  else if (revisions.length > 0 && !options.resolveRevision)
    notes.push(`no revision was confirmed because ${NO_PROBE}`)
  return {
    schemaVersion: 1,
    planID: state.planID,
    planRecordRevision: state.planRecordRevision,
    status,
    revisions,
    items,
    waivers: state.waivers,
    unreadable: state.unreadable,
    notes,
  }
}
