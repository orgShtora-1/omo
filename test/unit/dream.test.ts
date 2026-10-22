import { expect, test } from "bun:test"
import { resolveOptions } from "../../src/config/resolve"
import { parseOptions } from "../../src/config/schema"
import {
  DEFAULT_DREAM_CONFIG,
  dreamIdleDue,
  dreamVerdict,
  validateDreamConfig,
} from "../../src/memory/dream"

// The dream/time trigger: a reflection may only be queued as a "dream" after an
// observed idle gap, and at most once per configured cadence. The decision logic
// is pure — every timestamp arrives as an argument — so these tests pin the rule
// itself rather than the clock.

test("defaults enable the dream trigger with a 30 minute idle window and a 24 hour cadence", () => {
  expect(DEFAULT_DREAM_CONFIG).toEqual({
    enabled: true,
    idleMinutes: 30,
    minHoursBetween: 24,
  })
})

test("an idle gap only counts once a previous activity timestamp exists", () => {
  const config = { enabled: true, idleMinutes: 30, minHoursBetween: 24 }
  const now = 1_000_000_000_000
  // First observation: there is no gap to measure, so nothing is armed.
  expect(dreamIdleDue(config, undefined, now)).toBe(false)
  // One millisecond short of the window still does not arm the trigger.
  expect(dreamIdleDue(config, now - 30 * 60_000 + 1, now)).toBe(false)
  expect(dreamIdleDue(config, now - 30 * 60_000, now)).toBe(true)
  expect(dreamIdleDue(config, now - 45 * 60_000, now)).toBe(true)
})

test("a disabled dream configuration never arms from an idle gap", () => {
  const now = 1_000_000_000_000
  expect(
    dreamIdleDue({ enabled: false, idleMinutes: 30, minHoursBetween: 24 }, now - 60 * 60_000, now),
  ).toBe(false)
})

test("the verdict refuses without an armed idle gap and reports the exact reason", () => {
  const config = { enabled: true, idleMinutes: 30, minHoursBetween: 24 }
  expect(dreamVerdict(config, {}, 1_000)).toEqual({ due: false, reason: "no-idle-gap" })
  expect(dreamVerdict(config, { dreamDue: false }, 1_000)).toEqual({
    due: false,
    reason: "no-idle-gap",
  })
})

test("the verdict reports disabled before any other condition", () => {
  const config = { enabled: false, idleMinutes: 30, minHoursBetween: 24 }
  expect(dreamVerdict(config, { dreamDue: true }, 1_000)).toEqual({
    due: false,
    reason: "disabled",
  })
})

test("an armed gap allows exactly one dream per cadence window", () => {
  const config = { enabled: true, idleMinutes: 30, minHoursBetween: 24 }
  const now = 5_000_000_000_000
  // Armed and never dreamed: due.
  expect(dreamVerdict(config, { dreamDue: true }, now)).toEqual({ due: true })
  // Dreamed one millisecond ago: inside the cadence.
  expect(dreamVerdict(config, { dreamDue: true, dreamAt: now - 1 }, now)).toEqual({
    due: false,
    reason: "too-soon",
  })
  expect(dreamVerdict(config, { dreamDue: true, dreamAt: now - 24 * 3_600_000 + 1 }, now)).toEqual({
    due: false,
    reason: "too-soon",
  })
  // Exactly at the cadence boundary and beyond: due again.
  expect(dreamVerdict(config, { dreamDue: true, dreamAt: now - 24 * 3_600_000 }, now)).toEqual({
    due: true,
  })
  expect(dreamVerdict(config, { dreamDue: true, dreamAt: now - 48 * 3_600_000 }, now)).toEqual({
    due: true,
  })
})

test("activity timestamps are irrelevant to the verdict; only the armed gap decides", () => {
  const config = { enabled: true, idleMinutes: 30, minHoursBetween: 24 }
  expect(dreamVerdict(config, { activityAt: 1_000 }, 2_000)).toEqual({
    due: false,
    reason: "no-idle-gap",
  })
})

test("validateDreamConfig fills defaults for absent configuration", () => {
  expect(validateDreamConfig(undefined)).toEqual(DEFAULT_DREAM_CONFIG)
  expect(validateDreamConfig({})).toEqual(DEFAULT_DREAM_CONFIG)
  expect(validateDreamConfig({ enabled: false })).toEqual({
    enabled: false,
    idleMinutes: 30,
    minHoursBetween: 24,
  })
  expect(validateDreamConfig({ idleMinutes: 5, minHoursBetween: 2 })).toEqual({
    enabled: true,
    idleMinutes: 5,
    minHoursBetween: 2,
  })
})

test("validateDreamConfig fails closed on every malformed shape", () => {
  expect(() => validateDreamConfig("yes")).toThrow("invalid-dream-config")
  expect(() => validateDreamConfig({ enabled: 1 })).toThrow("invalid-dream-config")
  expect(() => validateDreamConfig({ idleMinutes: 0 })).toThrow("invalid-dream-config")
  expect(() => validateDreamConfig({ idleMinutes: 1.5 })).toThrow("invalid-dream-config")
  expect(() => validateDreamConfig({ minHoursBetween: -1 })).toThrow("invalid-dream-config")
  expect(() => validateDreamConfig({ idleMinutes: "30" })).toThrow("invalid-dream-config")
  expect(() => validateDreamConfig({ surprise: true })).toThrow("invalid-dream-config")
})

test("memory_dream defaults and round-trips through the options schema", () => {
  const defaults = parseOptions({ schemaVersion: 1 }) as { memory_dream?: unknown }
  expect(defaults.memory_dream).toEqual({ enabled: true, idleMinutes: 30, minHoursBetween: 24 })
  const explicit = resolveOptions(
    parseOptions({
      schemaVersion: 1,
      memory_dream: { enabled: false, idleMinutes: 5, minHoursBetween: 2 },
    }),
  )
  expect(explicit.memory_dream).toEqual({ enabled: false, idleMinutes: 5, minHoursBetween: 2 })
  const partial = resolveOptions(
    parseOptions({ schemaVersion: 1, memory_dream: { idleMinutes: 45 } }),
  )
  expect(partial.memory_dream).toEqual({ enabled: true, idleMinutes: 45, minHoursBetween: 24 })
})

test("memory_dream fails closed on malformed configuration", () => {
  expect(() => parseOptions({ schemaVersion: 1, memory_dream: 1 })).toThrow("memory_dream")
  expect(() => parseOptions({ schemaVersion: 1, memory_dream: [] })).toThrow("memory_dream")
  expect(() => parseOptions({ schemaVersion: 1, memory_dream: { idleMinutes: 0 } })).toThrow(
    "memory_dream.idleMinutes",
  )
  expect(() => parseOptions({ schemaVersion: 1, memory_dream: { enabled: 1 } })).toThrow(
    "memory_dream.enabled",
  )
  expect(() => parseOptions({ schemaVersion: 1, memory_dream: { surprise: true } })).toThrow(
    "memory_dream.surprise",
  )
  expect(() => parseOptions({ schemaVersion: 1, memory_dream: { minHoursBetween: -1 } })).toThrow(
    "memory_dream.minHoursBetween",
  )
})
