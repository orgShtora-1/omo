/** Keep diagnostics local and metadata-only. Redact known credential shapes before persistence. */
export function redactDiagnostic(value: string): string {
  return value
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9]{8,})\b/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@")
}
