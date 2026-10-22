import type { TeamMessage, TeamStore } from "./claims"
import { TeamError } from "./model"

export type { TeamMessage } from "./claims"

function aborted(): Error {
  return new DOMException("mailbox wait aborted", "AbortError")
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(aborted())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** At-least-once visibility; the recipient explicitly acknowledges only after processing. */
export async function waitForMessages(
  store: TeamStore,
  teamID: string,
  memberID: string,
  options: { signal: AbortSignal; intervalMs?: number },
): Promise<TeamMessage[]> {
  const interval = options.intervalMs ?? 250
  if (!Number.isSafeInteger(interval) || interval < 1)
    throw new TeamError("invalid-input", "mailbox interval must be a positive integer")
  while (true) {
    if (options.signal.aborted) throw aborted()
    const messages = await store.readMessages(teamID, memberID)
    if (options.signal.aborted) throw aborted()
    if (messages.length) return messages
    await delay(interval, options.signal)
  }
}
