import { rmSync } from "node:fs"
import { rm } from "node:fs/promises"

/**
 * Retry rmSync with exponential backoff to handle Windows EBUSY errors
 * where temp directories are still locked after test completion.
 */
export function rmSyncRetry(
  path: string,
  options: { recursive?: boolean; force?: boolean; retries?: number; delayMs?: number } = {},
): void {
  const { recursive = true, force = true, retries = 3, delayMs = 200 } = options

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      rmSync(path, { recursive, force })
      return
    } catch (error) {
      lastError = error as Error
      // Only retry on EBUSY/ENOTEMPTY/EPERM (Windows locking issues)
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") {
        throw error
      }
      if (attempt < retries) {
        // Exponential backoff with jitter
        const delay = delayMs * 2 ** attempt + Math.random() * 10
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
      }
    }
  }
  throw lastError
}

/**
 * Async version of rmSyncRetry for use with node:fs/promises rm()
 */
export async function rmRetry(
  path: string,
  options: { recursive?: boolean; force?: boolean; retries?: number; delayMs?: number } = {},
): Promise<void> {
  const { recursive = true, force = true, retries = 10, delayMs = 100 } = options

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await rm(path, { recursive, force })
      return
    } catch (error) {
      lastError = error as Error
      // Only retry on EBUSY/ENOTEMPTY/EPERM (Windows locking issues)
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") {
        throw error
      }
      if (attempt < retries) {
        // Exponential backoff with jitter
        const delay = delayMs * 2 ** attempt + Math.random() * 10
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  throw lastError
}
