import { expect, test } from "bun:test"
import { ProcessError, runBounded } from "../../src/subprocess"

// TDD seam for the shared bounded-spawn helper: real child processes with
// deterministic scripts, no host or network dependency.
const node = process.execPath

test("returns exit codes without throwing", async () => {
  const result = await runBounded(node, ["-e", "process.exit(3);"], { timeoutMs: 5000 })
  expect(result.exit).toBe(3)
  expect(result.truncated).toBe(false)
})

test("caps runaway output and marks truncation", async () => {
  const result = await runBounded(node, ["-e", "process.stdout.write('x'.repeat(200000));"], {
    timeoutMs: 5000,
    maxStdout: 1024,
  })
  expect(result.exit).toBe(0)
  expect(result.truncated).toBe(true)
  expect(result.stdout.length).toBeLessThan(200000)
  expect(result.stdout).toContain("[omo-truncated: output capped]")
})

test("rejects hung processes with a distinct timeout code", async () => {
  const error = await runBounded(node, ["-e", "setTimeout(()=>{}, 10000);"], {
    timeoutMs: 100,
  }).catch((cause) => cause)
  expect(error).toBeInstanceOf(ProcessError)
  expect((error as ProcessError).code).toBe("timeout")
})

test("rejects missing commands with a spawn code", async () => {
  const error = await runBounded("omo-definitely-missing-binary-xyz", [], {
    timeoutMs: 5000,
  }).catch((cause) => cause)
  expect(error).toBeInstanceOf(ProcessError)
  expect((error as ProcessError).code).toBe("spawn")
})

test("aborted callers cancel the child instead of timing out", async () => {
  const controller = new AbortController()
  const pending = runBounded(node, ["-e", "setTimeout(()=>{}, 10000);"], {
    timeoutMs: 10000,
    signal: controller.signal,
  }).catch((cause) => cause)
  controller.abort()
  const error = await pending
  expect(error).toBeInstanceOf(ProcessError)
  expect((error as ProcessError).code).toBe("cancelled")
})
