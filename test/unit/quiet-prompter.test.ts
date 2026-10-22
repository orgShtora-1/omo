import { expect, test } from "bun:test"
import { startQuietPrompter } from "../../src/events/quiet"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("calls onQuiet once the stream has been quiet past the window", async () => {
  const controller = new AbortController()
  let calls = 0
  const stop = startQuietPrompter({
    signal: controller.signal,
    intervalMs: 10,
    quietMs: 50,
    now: () => 1000,
    lastActivity: () => 0,
    onQuiet: async () => {
      calls += 1
    },
  })
  try {
    await sleep(60)
    expect(calls).toBeGreaterThanOrEqual(1)
  } finally {
    await stop()
  }
})

test("skips onQuiet while the stream is active", async () => {
  const controller = new AbortController()
  let calls = 0
  const now = 1000
  const stop = startQuietPrompter({
    signal: controller.signal,
    intervalMs: 10,
    quietMs: 50,
    now: () => now,
    lastActivity: () => now - 10,
    onQuiet: async () => {
      calls += 1
    },
  })
  try {
    await sleep(60)
    expect(calls).toBe(0)
  } finally {
    await stop()
  }
})

test("never overlaps a slow onQuiet", async () => {
  const controller = new AbortController()
  let calls = 0
  let concurrent = 0
  let maxConcurrent = 0
  const stop = startQuietPrompter({
    signal: controller.signal,
    intervalMs: 10,
    quietMs: 50,
    now: () => 1000,
    lastActivity: () => 0,
    onQuiet: async () => {
      calls += 1
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await sleep(40)
      concurrent -= 1
    },
  })
  try {
    await sleep(100)
    expect(maxConcurrent).toBe(1)
    expect(calls).toBeGreaterThanOrEqual(1)
  } finally {
    await stop()
  }
})

test("stop waits for the in-flight tick and halts further ticks", async () => {
  const controller = new AbortController()
  let calls = 0
  let released = false
  const stop = startQuietPrompter({
    signal: controller.signal,
    intervalMs: 10,
    quietMs: 50,
    now: () => 1000,
    lastActivity: () => 0,
    onQuiet: async () => {
      calls += 1
      while (!released) await sleep(5)
    },
  })
  await sleep(30)
  expect(calls).toBeGreaterThanOrEqual(1)
  const stopping = stop()
  released = true
  await stopping
  const callsAfter = calls
  await sleep(40)
  expect(calls).toBe(callsAfter)
})

test("does nothing once the signal is aborted", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const stop = startQuietPrompter({
    signal: controller.signal,
    intervalMs: 10,
    quietMs: 50,
    now: () => 1000,
    lastActivity: () => 0,
    onQuiet: async () => {
      calls += 1
    },
  })
  try {
    await sleep(40)
    expect(calls).toBe(0)
  } finally {
    await stop()
  }
})

test("onTick runs on every evaluation even when the stream is busy", async () => {
  const controller = new AbortController()
  let ticks = 0
  let quiets = 0
  const stop = startQuietPrompter({
    signal: controller.signal,
    intervalMs: 10,
    quietMs: 60_000,
    now: () => 1000,
    lastActivity: () => 1000,
    onQuiet: async () => {
      quiets += 1
    },
    onTick: () => {
      ticks += 1
    },
  })
  try {
    await sleep(50)
    expect(ticks).toBeGreaterThan(0)
    expect(quiets).toBe(0)
  } finally {
    await stop()
  }
})

test("shouldFire replaces the silence gate", async () => {
  const controller = new AbortController()
  let quiets = 0
  const stop = startQuietPrompter({
    signal: controller.signal,
    intervalMs: 10,
    quietMs: 60_000,
    // The stream looks busy forever, which would normally keep the gate shut.
    lastActivity: () => Date.now(),
    shouldFire: () => true,
    onQuiet: async () => {
      quiets += 1
    },
  })
  try {
    await sleep(50)
    expect(quiets).toBeGreaterThan(0)
  } finally {
    await stop()
  }
})
