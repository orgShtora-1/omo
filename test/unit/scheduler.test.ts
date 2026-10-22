import { expect, test } from "bun:test"
import { classifyFailure } from "../../src/execution/retry"
import { createScheduler } from "../../src/execution/scheduler"

const options = { maxChildren: 3, timeoutMs: 1000, maxRetries: 2, maxAttempts: 3 }
const request = (id: string) => ({
  projectID: "p",
  parentSessionID: "s",
  taskID: id,
  route: { kind: "agent" as const, id: "a" },
  prompt: id,
  skills: [],
  background: true,
})
const resolved = { agentID: "a", prompt: "x", skills: [], background: true }
for (const background of [false, true]) {
  test(`legacy timeout is the fallback for ${background ? "background" : "foreground"} requests`, async () => {
    const scheduler = createScheduler(
      { ...options, timeoutMs: 10 },
      async (_req, _resolved, signal) => {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        )
        throw new Error("unreachable")
      },
    )
    try {
      await expect(
        scheduler.schedule(
          { ...request("legacy"), background },
          resolved,
          new AbortController().signal,
        ),
      ).rejects.toThrow("timeout")
    } finally {
      scheduler.dispose()
    }
  })
  test(`timeout uses original ${background ? "background" : "foreground"} request, not resolved mode`, async () => {
    const modeOptions = {
      ...options,
      foregroundTimeoutMs: background ? 1000 : 10,
      backgroundTimeoutMs: background ? 10 : 1000,
    }
    const scheduler = createScheduler(modeOptions, async (req, _resolved, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100)
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            reject(signal.reason)
          },
          { once: true },
        )
      })
      return { attemptID: req.taskID, sessionID: req.taskID, state: "completed" }
    })
    try {
      await expect(
        scheduler.schedule(
          { ...request("mode"), background },
          { ...resolved, background: !background },
          new AbortController().signal,
        ),
      ).rejects.toThrow("timeout")
      expect(scheduler.status()).toEqual({ active: 0, queued: 0 })
    } finally {
      scheduler.dispose()
    }
  })
}
for (const platform of ["win32", "linux"] as const) {
  test(`file ownership respects ${platform} case semantics`, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
    if (!descriptor) throw new Error("process.platform descriptor is unavailable")
    const started: string[] = []
    const scheduler = createScheduler(options, async (req) => {
      started.push(req.taskID)
      return { attemptID: req.taskID, sessionID: req.taskID, state: "completed" }
    })
    const release = scheduler.reserve(
      "held",
      { ...request("held"), files: ["src/Widget.ts"] },
      resolved,
    )
    let run: Promise<unknown> | undefined
    try {
      Object.defineProperty(process, "platform", { ...descriptor, value: platform })
      run = scheduler.schedule(
        { ...request("next"), files: ["src/widget.ts"] },
        resolved,
        new AbortController().signal,
      )
      expect(started).toEqual(platform === "win32" ? [] : ["next"])
    } finally {
      Object.defineProperty(process, "platform", descriptor)
      release()
    }
    const pending = run
    if (!pending) throw new Error("scheduler did not start the conflicting run")
    await pending
    scheduler.dispose()
  })
}
test("three independent admissions overlap, fourth waits, queued cancellation does not launch", async () => {
  const started: string[] = []
  const finish: Array<() => void> = []
  const scheduler = createScheduler(options, async (req) => {
    started.push(req.taskID)
    await new Promise<void>((resolve) => finish.push(resolve))
    return { attemptID: req.taskID, sessionID: req.taskID, state: "completed" }
  })
  const controller = new AbortController()
  const runs = ["1", "2", "3"].map((id) =>
    scheduler.schedule(request(id), resolved, new AbortController().signal),
  )
  const queued = scheduler.schedule(request("4"), resolved, controller.signal)
  expect(started).toEqual(["1", "2", "3"])
  controller.abort()
  await expect(queued).rejects.toBeDefined()
  finish.forEach((resolve) => {
    resolve()
  })
  await Promise.all(runs)
  expect(started).toEqual(["1", "2", "3"])
  expect(scheduler.status()).toEqual({ active: 0, queued: 0 })
})
test("queued entry fails with admission-timeout instead of pending forever", async () => {
  const started: string[] = []
  const finish: Array<() => void> = []
  const scheduler = createScheduler(
    { ...options, maxChildren: 1, admissionTimeoutMs: 20 },
    async (req) => {
      started.push(req.taskID)
      await new Promise<void>((resolve) => finish.push(resolve))
      return { attemptID: req.taskID, sessionID: req.taskID, state: "completed" }
    },
  )
  try {
    const first = scheduler.schedule(request("first"), resolved, new AbortController().signal)
    const second = scheduler.schedule(request("second"), resolved, new AbortController().signal)
    await expect(second).rejects.toThrow("admission-timeout")
    expect(started).toEqual(["first"])
    expect(scheduler.status()).toEqual({ active: 1, queued: 0 })
    finish.forEach((resolve) => {
      resolve()
    })
    await first
    expect(scheduler.status()).toEqual({ active: 0, queued: 0 })
  } finally {
    scheduler.dispose()
  }
})
test("queued entry admitted within the budget starts once a slot frees", async () => {
  const started: string[] = []
  const scheduler = createScheduler(
    { ...options, maxChildren: 1, admissionTimeoutMs: 5000 },
    async (req) => {
      started.push(req.taskID)
      return { attemptID: req.taskID, sessionID: req.taskID, state: "completed" as const }
    },
  )
  try {
    const first = scheduler.schedule(request("first"), resolved, new AbortController().signal)
    const second = scheduler.schedule(request("second"), resolved, new AbortController().signal)
    expect(await second).toEqual({ attemptID: "second", sessionID: "second", state: "completed" })
    await first
    expect(started).toEqual(["first", "second"])
  } finally {
    scheduler.dispose()
  }
})
test("timeout reaches running work and permission failures are not retried", async () => {
  let attempts = 0
  const scheduler = createScheduler(
    { ...options, timeoutMs: 10 },
    async (_req, _resolved, signal) => {
      attempts++
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      )
      throw new Error("unreachable")
    },
  )
  await expect(
    scheduler.schedule(request("t"), resolved, new AbortController().signal),
  ).rejects.toThrow("timeout")
  expect(attempts).toBe(1)
  expect(classifyFailure({ status: 403 })).toBe("permission")
  expect(classifyFailure({ status: 429 })).toBe("transient")
  expect(classifyFailure({ code: "invalid-model" })).toBe("configuration")
  // Message-only provider failures: no numeric status is surfaced.
  expect(classifyFailure({ message: "request failed with HTTP 429" })).toBe("transient")
  expect(classifyFailure({ message: "Rate limit exceeded, retry later" })).toBe("transient")
  expect(classifyFailure({ message: "Too many requests, slow down" })).toBe("transient")
  expect(classifyFailure({ code: "EAI_AGAIN", message: "getaddrinfo EAI_AGAIN" })).toBe("transient")
  expect(classifyFailure({ message: "socket timeout after 30s" })).toBe("transient")
  expect(classifyFailure({ message: "model quota exhausted for billing period" })).toBe("terminal")
})
