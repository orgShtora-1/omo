export type FailureClass = "transient" | "configuration" | "permission" | "terminal"
export function classifyFailure(error: unknown): FailureClass {
  const value = error as { code?: string; status?: number; cause?: unknown; message?: string }
  if (
    value?.status === 401 ||
    value?.status === 403 ||
    /permission|denied|unauthorized|auth/i.test(`${value?.code} ${value?.message}`)
  )
    return "permission"
  if (
    /unknown-agent|primary-agent|invalid-model|unknown-skill|configuration|depth-exceeded/i.test(
      `${value?.code} ${value?.message}`,
    )
  )
    return "configuration"
  if (
    value?.status === 429 ||
    (value?.status !== undefined && value.status >= 500) ||
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|ENETUNREACH|EHOSTUNREACH|temporarily unavailable|service unavailable|timed?\s?out|429|rate.?limit|too many requests|overloaded/i.test(
      `${value?.code} ${value?.message}`,
    )
  )
    return "transient"
  return value?.cause ? classifyFailure(value.cause) : "terminal"
}
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(signal.reason ?? new Error("cancelled"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}
