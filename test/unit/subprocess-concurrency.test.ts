import { describe, expect, it } from "bun:test"
import { ProcessError, runBounded } from "../../src/subprocess"

const node = process.execPath

describe("subprocess retry logic", () => {
  it("returns result on first try when command succeeds", async () => {
    const result = await runBounded(node, ["-e", "console.log('ok'); process.exit(0);"], {
      timeoutMs: 5000,
    })
    expect(result.exit).toBe(0)
    expect(result.stdout).toContain("ok")
    expect(result.truncated).toBe(false)
  })

  it("rejects with timeout code on slow command", async () => {
    const error = await runBounded(node, ["-e", "setTimeout(()=>{}, 30000);"], {
      timeoutMs: 50,
    }).catch((e) => e)
    expect(error).toBeInstanceOf(ProcessError)
    expect((error as ProcessError).code).toBe("timeout")
  })

  it("rejects with spawn code on missing binary", async () => {
    const error = await runBounded("nonexistent-binary-xyz-123", []).catch((e) => e)
    expect(error).toBeInstanceOf(ProcessError)
    expect((error as ProcessError).code).toBe("spawn")
  })

  it("rejects immediately when signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await runBounded(node, ["-e", "console.log('x');"], {
      signal: controller.signal,
    }).catch((e) => e)
    expect(error).toBeInstanceOf(ProcessError)
    expect((error as ProcessError).code).toBe("cancelled")
  })

  it("rejects with cancelled code when aborted mid-execution", async () => {
    const controller = new AbortController()
    const promise = runBounded(node, ["-e", "setTimeout(()=>{}, 10000);"], {
      timeoutMs: 30000,
      signal: controller.signal,
    }).catch((e) => e)
    controller.abort()
    const error = await promise
    expect(error).toBeInstanceOf(ProcessError)
    expect((error as ProcessError).code).toBe("cancelled")
  })

  it("caps stdout to maxStdout and marks truncated", async () => {
    const result = await runBounded(node, ["-e", "process.stdout.write('A'.repeat(50000));"], {
      timeoutMs: 5000,
      maxStdout: 1024,
    })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThan(50000)
    expect(result.stdout).toContain("[omo-truncated: output capped]")
  })

  it("caps stderr to maxStderr and marks truncated", async () => {
    const result = await runBounded(node, ["-e", "process.stderr.write('E'.repeat(20000));"], {
      timeoutMs: 5000,
      maxStderr: 512,
    })
    expect(result.truncated).toBe(true)
    expect(result.stderr.length).toBeLessThan(20000)
  })

  it("propagates exit code from child", async () => {
    const result = await runBounded(node, ["-e", "process.exit(42);"], { timeoutMs: 5000 })
    expect(result.exit).toBe(42)
  })

  it("passes custom env to child process", async () => {
    const result = await runBounded(node, ["-e", "console.log(process.env.MY_VAR);"], {
      env: { MY_VAR: "hello-world" },
      timeoutMs: 5000,
    })
    expect(result.stdout.trim()).toBe("hello-world")
  })

  it("runs in the specified cwd", async () => {
    const result = await runBounded(node, ["-e", "console.log(process.cwd());"], {
      cwd: "/tmp",
      timeoutMs: 5000,
    })
    // On Windows, Node.js normalizes /tmp to C:\tmp (or similar)
    // Accept either the Unix-style or Windows-style path
    const actualCwd = result.stdout.trim()
    expect(actualCwd).toMatch(/^(\/tmp|[A-Z]:[\\/]tmp)$/i)
  })
})

describe("subprocess concurrency safety", () => {
  it("runs multiple bounded processes concurrently without interference", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        runBounded(node, ["-e", `console.log(${i});`], { timeoutMs: 5000 }),
      ),
    )
    const outputs = results.map((r) => r.stdout.trim())
    for (let i = 0; i < 10; i++) {
      expect(outputs).toContain(String(i))
    }
  })

  it("handles concurrent timeouts correctly", async () => {
    const errors = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        runBounded(node, ["-e", "setTimeout(()=>{}, 60000);"], { timeoutMs: 10 }),
      ),
    )
    for (const result of errors) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(ProcessError)
        expect((result.reason as ProcessError).code).toBe("timeout")
      }
    }
  })
})
