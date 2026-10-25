/**
 * Distinguishes graceful runtime teardown (reload/unload) from an explicit
 * cancellation: observers must stop polling and leave the durable journal
 * record unresolved ("admitted") so the next runtime instance can reconcile
 * and adopt the still-running child, instead of interrupting it.
 */
import { OmoError } from "../errors/base.js"

export class RuntimeDetach extends OmoError {
  constructor() {
    super("runtime-detach", "runtime unloaded")
  }
}

export function isDetachReason(reason: unknown): boolean {
  return reason instanceof RuntimeDetach
}
