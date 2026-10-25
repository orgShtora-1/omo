import { spawn } from "node:child_process"
import { OmoError } from "./errors/base.js"
import { logError } from "./errors/logging.js"
import type { ERROR_CODES, ErrorCode } from "./errors/registry.js"

export type ProcessErrorCode = ErrorCode & (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export class ProcessError extends OmoError {
  constructor(code: ProcessErrorCode, message: string, options?: { cause?: unknown }) {
    super(code, message, options)
  }
}

export interface BoundedOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Reject with a `timeout` ProcessError after this long. Defaults to 30s. */
  timeoutMs?: number
  /** Tail-kept stdout cap in characters. Defaults to 64KiB. */
  maxStdout?: number
  /** Tail-kept stderr cap in characters. Defaults to 8KiB. */
  maxStderr?: number
  signal?: AbortSignal
}

export interface BoundedResult {
  exit: number
  stdout: string
  stderr: string
  truncated: boolean
}

const TRUNCATION_MARK = "\n…[omo-truncated: output capped]"

/** Single bounded-spawn seam: argv only (never a shell string), output caps against
 * runaway logs, and a hard timeout so hung children cannot stall the runtime. */
export function runBounded(
  command: string,
  args: string[],
  options: BoundedOptions = {},
): Promise<BoundedResult> {
  const { cwd, env, timeoutMs = 30_000, maxStdout = 65_536, maxStderr = 8_192, signal } = options
  if (signal?.aborted)
    return Promise.reject(new ProcessError("cancelled", `${command} aborted before spawn`))
  return new Promise<BoundedResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      reject(
        new ProcessError(
          "spawn",
          `${command} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      return
    }
    let out = ""
    let error = ""
    let truncated = false
    let settled = false
    const append = (current: string, chunk: unknown, cap: number): string => {
      const next = current + String(chunk)
      if (next.length <= cap) return next
      truncated = true
      return next.slice(-cap)
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      action()
    }
    const kill = () => {
      try {
        child.kill("SIGKILL")
      } catch {
        // Already exited; the close handler settles below.
      }
    }
    const timer = setTimeout(() => {
      kill()
      settle(() => reject(new ProcessError("timeout", `${command} timed out after ${timeoutMs}ms`)))
    }, timeoutMs)
    timer.unref?.()
    const onAbort = () => {
      kill()
      settle(() => reject(new ProcessError("cancelled", `${command} aborted`)))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    const stdout = child.stdout
    const stderr = child.stderr
    if (!stdout || !stderr) {
      cleanup()
      try {
        child.kill("SIGKILL")
      } catch {
        // Already exited; nothing to settle.
      }
      reject(new ProcessError("spawn", `${command} produced no output pipes`))
      return
    }
    stdout.on("data", (chunk) => {
      out = append(out, chunk.toString(), maxStdout)
    })
    stderr.on("data", (chunk) => {
      error = append(error, chunk.toString(), maxStderr)
    })
    child.once("error", (cause) => {
      settle(() =>
        reject(
          new ProcessError(
            "spawn",
            `${command} unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        ),
      )
    })
    child.once("close", (code) => {
      settle(() =>
        resolve({
          exit: code ?? -1,
          stdout: truncated ? out + TRUNCATION_MARK : out.trim(),
          stderr: truncated ? error + TRUNCATION_MARK : error.trim(),
          truncated,
        }),
      )
    })
  })
}
