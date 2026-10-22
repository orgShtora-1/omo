import { describe, expect, test } from "bun:test"
import { type ResolvedOptions, resolveOptions } from "../../src/config/resolve"
import { type OmoOptions, OptionsError, parseOptions } from "../../src/config/schema"
import type { Notice } from "../../src/execution/notifications"
import {
  createOsNotifier,
  createOsResultSink,
  DEFAULT_OS_NOTIFICATIONS,
  type OsSkipReason,
  planOsNotification,
  withOsNotifications,
} from "../../src/execution/os-notifications"
import type { BoundedResult } from "../../src/subprocess"
import { ProcessError } from "../../src/subprocess"

// Parity gap #4 (upstream sessionNotification/task-toast-manager): OS
// notifications for the same execution outcomes the in-app notifier surfaces.
// The platform command is planned by a pure function and executed through the
// shared bounded-spawn seam; every skip is a recorded exact reason, never a
// throw into the event stream.

interface RunnerCall {
  command: string
  args: string[]
  options: { timeoutMs?: number }
}

function result(exit: number): BoundedResult {
  return { exit, stdout: "", stderr: "", truncated: false }
}

function recordingRunner(calls: RunnerCall[], outcome: () => Promise<BoundedResult>) {
  return async (command: string, args: string[], options: { timeoutMs?: number }) => {
    calls.push({ command, args, options })
    return await outcome()
  }
}

function scriptOf(plan: ReturnType<typeof planOsNotification>): string {
  if ("skip" in plan) throw new Error("expected a command plan")
  const script = plan.args[3]
  if (typeof script !== "string") throw new Error("missing -Command script")
  return script
}

// The PowerShell AUMID pinned independently from the implementation: the
// toast is issued through Windows PowerShell's own AppUserModelID, which the
// Action Center accepts without registering a custom AppId.
const toastAppId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"

function expectedToastScript(title: string, body: string): string {
  return [
    "$ErrorActionPreference='Stop';",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null;",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;",
    `$xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">' + ${title} + '</text><text id="2">' + ${body} + '</text></binding></visual></toast>');`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml;",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${toastAppId}').Show($toast)`,
  ].join(" ")
}

function expectOptionError(input: unknown, path: string): void {
  try {
    const parsed = parseOptions(input)
    resolveOptions(parsed)
  } catch (err) {
    expect(err).toBeInstanceOf(OptionsError)
    expect((err as OptionsError).path).toBe(path)
    return
  }
  throw new Error(`esperava OptionsError em ${path}, mas parseou`)
}

describe("planOsNotification (pure platform planner)", () => {
  test("win32 plans a PowerShell WinRT toast with the notice text", () => {
    const plan = planOsNotification("win32", { title: "OmO", body: "task done" })
    expect(plan).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expectedToastScript("'OmO'", "'task done'"),
      ],
    })
  })

  test("win32 plan XML-escapes and PowerShell-quotes hostile notice text", () => {
    // The XML text contract pinned independently: ampersands and angle brackets
    // become numeric character references, and a single quote doubles inside
    // the PowerShell literal.
    const amp = `&#${38};`
    const lt = `&#${60};`
    const gt = `&#${62};`
    const plan = planOsNotification("win32", {
      title: "OmO & <sons>",
      body: "failed: 'quote' & <tag>\nsecond",
    })
    expect(plan).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expectedToastScript(
          `'OmO ${amp} ${lt}sons${gt}'`,
          `'failed: ''quote'' ${amp} ${lt}tag${gt}\nsecond'`,
        ),
      ],
    })
  })

  test("win32 plan strips XML-invalid control characters but keeps tabs and newlines", () => {
    const plan = planOsNotification("win32", { title: "OmO", body: "a\u0000b\u0007c\td" })
    expect(scriptOf(plan)).toContain("'abc\td'")
  })

  test("win32 plan caps the toast title at 64 and the body at 512 characters", () => {
    const body = planOsNotification("win32", { title: "OmO", body: "a".repeat(600) })
    expect(scriptOf(body)).toContain(`'${"a".repeat(512)}…'`)
    expect(scriptOf(body)).not.toContain(`'${"a".repeat(513)}`)
    const title = planOsNotification("win32", { title: "t".repeat(80), body: "x" })
    expect(scriptOf(title)).toContain(`'${"t".repeat(64)}…'`)
  })

  test("linux and darwin plan notify-send with the notice verbatim", () => {
    const expected = { command: "notify-send", args: ["--", "OmO", "task done"] }
    expect(planOsNotification("linux", { title: "OmO", body: "task done" })).toEqual(expected)
    expect(planOsNotification("darwin", { title: "OmO", body: "task done" })).toEqual(expected)
  })

  test("unknown platforms are a recorded no-op", () => {
    for (const platform of ["sunos", "haiku", "", "os2"]) {
      expect(planOsNotification(platform, { title: "OmO", body: "task done" })).toEqual({
        skip: "unsupported-platform",
      })
    }
  })
})

describe("createOsNotifier (fail-closed, never throws)", () => {
  test("disabled records the exact reason and never spawns", async () => {
    const calls: RunnerCall[] = []
    const notify = createOsNotifier(
      { enabled: false, timeoutMs: 4_000 },
      { platform: "linux", run: recordingRunner(calls, async () => result(0)) },
    )
    expect(await notify({ title: "OmO", body: "task done" })).toEqual({
      delivered: false,
      reason: "disabled",
    })
    expect(calls).toEqual([])
  })

  test("unsupported platforms record the exact reason without spawning", async () => {
    const calls: RunnerCall[] = []
    const notify = createOsNotifier(
      { enabled: true, timeoutMs: 4_000 },
      { platform: "sunos", run: recordingRunner(calls, async () => result(0)) },
    )
    expect(await notify({ title: "OmO", body: "x" })).toEqual({
      delivered: false,
      reason: "unsupported-platform",
    })
    expect(calls).toEqual([])
  })

  test("delivers on exit 0 and passes the configured timeout to the runner", async () => {
    const calls: RunnerCall[] = []
    const notify = createOsNotifier(
      { enabled: true, timeoutMs: 4_000 },
      { platform: "linux", run: recordingRunner(calls, async () => result(0)) },
    )
    expect(await notify({ title: "OmO", body: "task done" })).toEqual({ delivered: true })
    expect(calls).toEqual([
      { command: "notify-send", args: ["--", "OmO", "task done"], options: { timeoutMs: 4_000 } },
    ])
  })

  test("non-zero notifier exits are recorded as failures", async () => {
    const notify = createOsNotifier(
      { enabled: true, timeoutMs: 4_000 },
      { platform: "linux", run: async () => result(3) },
    )
    expect(await notify({ title: "OmO", body: "x" })).toEqual({
      delivered: false,
      reason: "notifier-failed",
    })
  })

  test("spawn, timeout and cancellation failures record exact reasons and never throw", async () => {
    const cases: Array<[OsSkipReason, () => Promise<never>]> = [
      [
        "notifier-unavailable",
        async () => {
          throw new ProcessError("spawn", "notify-send unavailable: ENOENT")
        },
      ],
      [
        "notifier-timeout",
        async () => {
          throw new ProcessError("timeout", "notify-send timed out after 4000ms")
        },
      ],
      [
        "notifier-cancelled",
        async () => {
          throw new ProcessError("cancelled", "notify-send aborted")
        },
      ],
    ]
    for (const [reason, outcome] of cases) {
      const notify = createOsNotifier(
        { enabled: true, timeoutMs: 4_000 },
        { platform: "linux", run: outcome },
      )
      expect(await notify({ title: "OmO", body: "x" })).toEqual({ delivered: false, reason })
    }
  })

  test("unknown runner failures are recorded, never thrown", async () => {
    const notify = createOsNotifier(
      { enabled: true, timeoutMs: 4_000 },
      {
        platform: "linux",
        run: async () => {
          throw new Error("boom")
        },
      },
    )
    expect(await notify({ title: "OmO", body: "x" })).toEqual({
      delivered: false,
      reason: "notifier-failed",
    })
  })

  test("the platform defaults to process.platform", async () => {
    const calls: RunnerCall[] = []
    const notify = createOsNotifier(
      { enabled: true, timeoutMs: 4_000 },
      { run: recordingRunner(calls, async () => result(0)) },
    )
    const delivery = await notify({ title: "OmO", body: "x" })
    if (process.platform === "win32") {
      expect(calls[0]?.command).toBe("powershell.exe")
      expect(delivery).toEqual({ delivered: true })
    } else if (process.platform === "linux" || process.platform === "darwin") {
      expect(calls[0]?.command).toBe("notify-send")
      expect(delivery).toEqual({ delivered: true })
    } else {
      expect(calls).toEqual([])
      expect(delivery).toEqual({ delivered: false, reason: "unsupported-platform" })
    }
  })
})

describe("in-app notice mirroring", () => {
  const notice: Notice = {
    sessionID: "parent",
    id: "msg_omo_result_a",
    text: "OmO task a: completed. Session: child. Attempt: a.",
    description: "OmO: a — completed",
    delivery: "queue",
    resume: true,
    metadata: { "omo.attemptIDs": ["a"] },
  }

  test("createOsResultSink mirrors the in-app result notice onto the OS channel", async () => {
    const calls: RunnerCall[] = []
    const sink = createOsResultSink(
      { enabled: true, timeoutMs: 4_000 },
      { platform: "linux", run: recordingRunner(calls, async () => result(0)) },
    )
    expect(await sink(notice)).toEqual({ delivered: true })
    expect(calls).toEqual([
      {
        command: "notify-send",
        args: ["--", "OmO", "OmO task a: completed. Session: child. Attempt: a."],
        options: { timeoutMs: 4_000 },
      },
    ])
  })

  test("withOsNotifications starts the OS flight, awaits the primary send and keeps its result", async () => {
    const order: string[] = []
    const wrapped = withOsNotifications(
      async (received) => {
        order.push("send")
        expect(received).toBe(notice)
        return "ack"
      },
      async (received) => {
        order.push("os")
        expect(received).toBe(notice)
        return { delivered: true }
      },
    )
    expect(await wrapped(notice)).toBe("ack")
    expect(order).toEqual(["os", "send"])
  })

  test("primary send failures still propagate; the OS channel never breaks them", async () => {
    const osCalls: Notice[] = []
    const wrapped = withOsNotifications(
      async () => {
        throw new Error("primary-down")
      },
      async (received) => {
        osCalls.push(received)
        return { delivered: false, reason: "unsupported-platform" }
      },
    )
    await expect(wrapped(notice)).rejects.toThrow("primary-down")
    expect(osCalls).toEqual([notice])
  })

  test("an OS delivery refusal resolves the wrapper normally", async () => {
    const wrapped = withOsNotifications(
      async () => "ack",
      async () => ({ delivered: false, reason: "disabled" }),
    )
    expect(await wrapped(notice)).toBe("ack")
  })
})

describe("config os_notifications (strict, fail-closed)", () => {
  test("DEFAULT_OS_NOTIFICATIONS is off with the exact subprocess timeout", () => {
    expect(DEFAULT_OS_NOTIFICATIONS).toEqual({ enabled: false, timeoutMs: 10_000 })
  })

  test("defaults are off and resolve unchanged", () => {
    const parsed: OmoOptions = parseOptions({ schemaVersion: 1 })
    expect(parsed.os_notifications).toEqual({ enabled: false, timeoutMs: 10_000 })
    const resolved: ResolvedOptions = resolveOptions(parsed)
    expect(resolved.os_notifications).toEqual({ enabled: false, timeoutMs: 10_000 })
  })

  test("explicit values round-trip through parse and resolve", () => {
    const resolved = resolveOptions(
      parseOptions({ schemaVersion: 1, os_notifications: { enabled: true, timeoutMs: 2_500 } }),
    )
    expect(resolved.os_notifications).toEqual({ enabled: true, timeoutMs: 2_500 })
  })

  test("non-object values and unknown keys are rejected with field paths", () => {
    expectOptionError({ schemaVersion: 1, os_notifications: 1 }, "os_notifications")
    expectOptionError({ schemaVersion: 1, os_notifications: [] }, "os_notifications")
    expectOptionError({ schemaVersion: 1, os_notifications: "x" }, "os_notifications")
    expectOptionError(
      { schemaVersion: 1, os_notifications: { surprise: true } },
      "os_notifications.surprise",
    )
  })

  test("non-boolean enabled is rejected", () => {
    for (const value of [1, "on", null, [], {}]) {
      expectOptionError(
        { schemaVersion: 1, os_notifications: { enabled: value } },
        "os_notifications.enabled",
      )
    }
  })

  test("non-safe-integer or non-positive timeoutMs is rejected", () => {
    for (const value of [0, -1, 1.5, "2", null, 2 ** 53]) {
      expectOptionError(
        { schemaVersion: 1, os_notifications: { timeoutMs: value } },
        "os_notifications.timeoutMs",
      )
    }
  })
})
