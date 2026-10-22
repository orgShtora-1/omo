import type { DelegationRequest, ResolvedDelegation, RunHandle } from "../contracts"
import { RuntimeDetach } from "./detach"
import { abortableSleep, classifyFailure } from "./retry"

export type SchedulerOptions = {
  maxChildren: number
  timeoutMs: number
  foregroundTimeoutMs?: number
  backgroundTimeoutMs?: number
  /** Queued entries fail with admission-timeout once this budget is exceeded. */
  admissionTimeoutMs?: number
  maxRetries: number
  maxAttempts: number
  providerLimits?: Record<string, number>
  modelLimits?: Record<string, number>
}
type Entry = {
  request: DelegationRequest
  resolved: ResolvedDelegation
  signal: AbortSignal
  run: () => void
  reject: (error: unknown) => void
  abort: () => void
}
function overlaps(left: string, right: string) {
  const prefix = (value: string) => {
    const segments = value.replace(/\\/g, "/").split(/[?*]/, 1)
    const head = segments[0] ?? ""
    const normalized = head.replace(/\/$/, "")
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
  }
  const a = prefix(left),
    b = prefix(right)
  return !a || !b || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}
export function createScheduler(
  options: SchedulerOptions,
  execute: (
    request: DelegationRequest,
    resolved: ResolvedDelegation,
    signal: AbortSignal,
  ) => Promise<RunHandle>,
  recoverable: (request: DelegationRequest) => Promise<boolean> = async () => true,
) {
  const queue: Entry[] = []
  const active = new Map<
    string,
    { request: DelegationRequest; resolved: ResolvedDelegation; controller: AbortController }
  >()
  let disposed = false
  const count = (
    test: (item: { request: DelegationRequest; resolved: ResolvedDelegation }) => boolean,
  ) => [...active.values()].filter(test).length
  function eligible(entry: Entry) {
    const model = entry.resolved.model
    const files = (entry.request as DelegationRequest & { files?: string[] }).files ?? []
    const ownershipConflict = [...active.values()].some(
      (item) =>
        item.request.projectID === entry.request.projectID &&
        files.some((file) =>
          ((item.request as DelegationRequest & { files?: string[] }).files ?? []).some((other) =>
            overlaps(file, other),
          ),
        ),
    )
    return (
      !ownershipConflict &&
      count((item) => item.request.projectID === entry.request.projectID) < options.maxChildren &&
      (!model ||
        count((item) => item.resolved.model?.providerID === model.providerID) <
          (options.providerLimits?.[model.providerID] ?? Infinity)) &&
      (!model ||
        count(
          (item) =>
            item.resolved.model?.providerID === model.providerID &&
            item.resolved.model?.modelID === model.modelID,
        ) < (options.modelLimits?.[`${model.providerID}/${model.modelID}`] ?? Infinity))
    )
  }
  function drain() {
    for (let index = 0; index < queue.length; ) {
      const entry = queue[index]
      if (!entry || !eligible(entry)) {
        index++
        continue
      }
      queue.splice(index, 1)
      entry.signal.removeEventListener("abort", entry.abort)
      entry.run()
    }
  }
  return {
    reserve(key: string, request: DelegationRequest, resolved: ResolvedDelegation) {
      if (active.has(key)) return () => {}
      active.set(key, { request, resolved, controller: new AbortController() })
      let released = false
      return () => {
        if (!released) {
          released = true
          active.delete(key)
          drain()
        }
      }
    },
    schedule(
      request: DelegationRequest,
      resolved: ResolvedDelegation,
      signal: AbortSignal,
    ): Promise<RunHandle> {
      if (disposed || signal.aborted) return Promise.reject(new Error("cancelled"))
      return new Promise((resolve, reject) => {
        // A queued entry must never pend forever: without this bound a full
        // capacity leaves the calling omo tool spinning with no feedback.
        const admissionTimeoutMs = options.admissionTimeoutMs ?? 120_000
        let admissionTimer: ReturnType<typeof setTimeout> | undefined
        const clearAdmissionTimer = () => {
          if (admissionTimer !== undefined) {
            clearTimeout(admissionTimer)
            admissionTimer = undefined
          }
        }
        const entry: Entry = {
          request,
          resolved,
          signal,
          reject,
          abort: () => {
            clearAdmissionTimer()
            const index = queue.indexOf(entry)
            if (index >= 0) queue.splice(index, 1)
            reject(signal.reason ?? new Error("cancelled"))
            drain()
          },
          run: () => {
            clearAdmissionTimer()
            const key = crypto.randomUUID()
            const controller = new AbortController()
            const abort = () => controller.abort(signal.reason)
            signal.addEventListener("abort", abort, { once: true })
            active.set(key, { request, resolved, controller })
            const timer = setTimeout(
              () => controller.abort(new Error("timeout")),
              (request.background ? options.backgroundTimeoutMs : options.foregroundTimeoutMs) ??
                options.timeoutMs,
            )
            void (async () => {
              try {
                for (let attempt = 0; ; attempt++) {
                  controller.signal.throwIfAborted()
                  try {
                    resolve(await execute(request, resolved, controller.signal))
                    break
                  } catch (error) {
                    if (
                      controller.signal.aborted ||
                      classifyFailure(error) !== "transient" ||
                      attempt >= Math.min(options.maxRetries, options.maxAttempts - 1) ||
                      !(await recoverable(request))
                    )
                      throw error
                    await abortableSleep(Math.min(1000 * 2 ** attempt, 10000), controller.signal)
                  }
                }
              } catch (error) {
                reject(error)
              } finally {
                clearTimeout(timer)
                signal.removeEventListener("abort", abort)
                active.delete(key)
                drain()
              }
            })()
          },
        }
        queue.push(entry)
        signal.addEventListener("abort", entry.abort, { once: true })
        drain()
        // drain() may start the entry immediately; arm the budget only while
        // it is still queued. entry.run() clears it once a slot opens later.
        if (queue.includes(entry)) {
          admissionTimer = setTimeout(() => {
            admissionTimer = undefined
            const index = queue.indexOf(entry)
            if (index < 0) return
            queue.splice(index, 1)
            reject(
              new Error(
                `admission-timeout: no capacity slot opened within ${admissionTimeoutMs}ms (active ${active.size}, queued ${queue.length}); ` +
                  `owned children may still be running - call omo_status to inspect, then retry once a slot frees or reduce concurrency`,
              ),
            )
            drain()
          }, admissionTimeoutMs)
        }
      })
    },
    status() {
      return { active: active.size, queued: queue.length }
    },
    cancel(parentSessionID: string, filter?: (request: DelegationRequest) => boolean) {
      const matches = (item: { request: DelegationRequest }) =>
        item.request.parentSessionID === parentSessionID &&
        (filter === undefined || filter(item.request))
      for (const entry of [...queue]) if (matches(entry)) entry.abort()
      for (const item of active.values())
        if (matches(item)) item.controller.abort(new Error("parent cancelled"))
    },
    dispose() {
      disposed = true
      for (const entry of [...queue]) entry.abort()
      for (const item of active.values()) item.controller.abort(new RuntimeDetach())
    },
  }
}
