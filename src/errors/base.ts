import type { ErrorCode } from "./registry.js"

export type { ErrorCode }
export type ErrorDetails = Record<string, unknown> | undefined

export class OmoError extends Error {
  readonly code: ErrorCode
  readonly path?: string
  readonly details?: ErrorDetails
  override readonly cause?: unknown

  constructor(
    code: ErrorCode,
    message: string,
    options?: { path?: string; details?: ErrorDetails; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined)
    this.name = this.constructor.name
    this.code = code
    this.path = options?.path
    this.details = options?.details
  }

  toJSON() {
    const result: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      message: this.message,
    }
    if (this.path) result.path = this.path
    if (this.details) result.details = this.details
    if (this.cause)
      result.cause =
        this.cause instanceof Error
          ? { name: this.cause.name, message: this.cause.message }
          : this.cause
    return result
  }
}
