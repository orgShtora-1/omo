/**
 * Structured error logger for @shtora/omo.
 *
 * Errors are logged with their code, message, path, details and cause chain.
 * The logger is a no-op by default; call `enableStructuredLogging()` to activate.
 */

import { OmoError } from "./base.js"

// ─── Log record shape ─────────────────────────────────────────────────────────
export interface ErrorLogEntry {
  timestamp: string
  level: "error" | "warn" | "info"
  code: string
  message: string
  path?: string
  details?: Record<string, unknown>
  cause?: string
  stack?: string
}

// ─── Mutable log sink (replaced by enableStructuredLogging) ───────────────────
type LogSink = (entry: ErrorLogEntry) => void

let sink: LogSink = () => {
  // no-op: structured logging disabled by default
}

// ─── Public API ────────────────────────────────────────────────────────────────
/**
 * Enable structured error logging by providing a sink function.
 * Typical usage: `enableStructuredLogging(console.error)` or pipe to a file.
 */
export function enableStructuredLogging(fn: LogSink): void {
  sink = fn
}

/**
 * Extract a plain-string cause chain from an error's `cause` property.
 * Stops after 5 links to avoid blowing up the log entry.
 */
function extractCauseChain(error: unknown, maxLinks = 5): string | undefined {
  if (!error || !(error instanceof Error)) return undefined
  const parts: string[] = []
  let current: unknown = error
  for (let i = 0; i < maxLinks; i++) {
    if (!(current instanceof Error)) break
    parts.push(current.message)
    current = current.cause
  }
  return parts.length > 0 ? parts.join(" <- ") : undefined
}

/**
 * Log an OmoError (or any Error) with full structured metadata.
 * Returns the entry so callers can inspect or chain it.
 */
export function logError(error: unknown): ErrorLogEntry {
  let code = "unknown"
  let message = "unexpected error"
  let path: string | undefined
  let details: Record<string, unknown> | undefined
  let stack: string | undefined

  if (error instanceof OmoError) {
    code = error.code
    message = error.message
    path = error.path
    details = error.details
    stack = error.stack
  } else if (error instanceof Error) {
    code = error.name.toLowerCase().replace(/\s+/g, "-")
    message = error.message
    stack = error.stack
  }

  const entry: ErrorLogEntry = {
    timestamp: new Date().toISOString(),
    level: "error",
    code,
    message,
    ...(path ? { path } : {}),
    ...(details ? { details } : {}),
    ...(stack ? { stack } : {}),
    cause: extractCauseChain(error),
  }

  sink(entry)
  return entry
}

/**
 * Convenience wrapper for non-OmoError paths (e.g. third-party libs).
 */
export function logWarning(message: string, details?: Record<string, unknown>): ErrorLogEntry {
  const entry: ErrorLogEntry = {
    timestamp: new Date().toISOString(),
    level: "warn",
    code: "warning",
    message,
    ...(details ? { details } : {}),
  }
  sink(entry)
  return entry
}

/**
 * Convenience wrapper for info-level operational messages.
 */
export function logInfo(message: string, details?: Record<string, unknown>): ErrorLogEntry {
  const entry: ErrorLogEntry = {
    timestamp: new Date().toISOString(),
    level: "info",
    code: "info",
    message,
    ...(details ? { details } : {}),
  }
  sink(entry)
  return entry
}

/** Clear the sink — useful in tests. */
export function disableStructuredLogging(): void {
  sink = () => {}
}
