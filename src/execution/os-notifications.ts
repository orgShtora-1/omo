import { type BoundedOptions, type BoundedResult, ProcessError, runBounded } from "../subprocess"
import type { Notice } from "./notifications"

/** OS notification policy (option `os_notifications`): mirrors the in-app
 * execution-result notices onto the operating system's notification surface.
 * Default off. */
export type OsNotificationsConfig = {
  enabled: boolean
  /** Hard cap for the platform notifier subprocess (shared bounded-spawn seam). */
  timeoutMs: number
}

export const DEFAULT_OS_NOTIFICATIONS: OsNotificationsConfig = {
  enabled: false,
  timeoutMs: 10_000,
}

/** One OS notification: a short app title and the event text. */
export type OsNotice = {
  title: string
  body: string
}

/** Exact refusal reasons; a skip is always recorded, never thrown. */
export type OsSkipReason =
  | "disabled"
  | "unsupported-platform"
  | "notifier-unavailable"
  | "notifier-timeout"
  | "notifier-cancelled"
  | "notifier-failed"

export type OsDelivery = { delivered: true } | { delivered: false; reason: OsSkipReason }

type OsCommandPlan = {
  command: string
  args: string[]
}

export type OsPlannedNotification = OsCommandPlan | { skip: "unsupported-platform" }

const TOAST_TITLE_CAP = 64
const TOAST_BODY_CAP = 512
const TOAST_TRUNCATION_MARK = "…"
// Toasts are issued through Windows PowerShell's own AppUserModelID: the
// Action Center accepts it without registering a custom AppId, and WinRT
// projection exists only in Windows PowerShell (powershell.exe), not pwsh.
const TOAST_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"

function cap(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}${TOAST_TRUNCATION_MARK}`
}

/** XML 1.0 text escaping: the toast payload is an XML document, so ampersands
 * and angle brackets must become numeric character references and forbidden
 * control characters must be stripped. */
function xmlText(value: string): string {
  let out = ""
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code === undefined) continue
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue
    if (character === "&" || character === "<" || character === ">") {
      out += `&#${code};`
      continue
    }
    out += character
  }
  return out
}

/** Single-quoted PowerShell literal: inside '' the only escape is a doubled '. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function toastScript(notice: OsNotice): string {
  const title = psQuote(xmlText(cap(notice.title, TOAST_TITLE_CAP)))
  const body = psQuote(xmlText(cap(notice.body, TOAST_BODY_CAP)))
  return [
    "$ErrorActionPreference='Stop';",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null;",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;",
    `$xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">' + ${title} + '</text><text id="2">' + ${body} + '</text></binding></visual></toast>');`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml;",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_APP_ID}').Show($toast)`,
  ].join(" ")
}

/** Pure platform planner: win32 → PowerShell WinRT toast; linux/darwin →
 * notify-send (used only when actually present on the host); anything else is
 * a recorded no-op. No spawn happens here, so the decision is testable
 * without a host. */
export function planOsNotification(platform: string, notice: OsNotice): OsPlannedNotification {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", toastScript(notice)],
    }
  }
  if (platform === "linux" || platform === "darwin") {
    return { command: "notify-send", args: ["--", notice.title, notice.body] }
  }
  return { skip: "unsupported-platform" }
}

/** The bounded-spawn seam this module runs through; injectable for tests. */
type OsRunner = (command: string, args: string[], options: BoundedOptions) => Promise<BoundedResult>

export type OsNotifierDeps = {
  platform?: string
  run?: OsRunner
}

/** Builds the OS delivery function. It NEVER throws: every refusal or failure
 * is returned as an exact recorded reason, so the event stream that produced
 * the notice cannot be broken by the auxiliary channel. */
export function createOsNotifier(
  config: OsNotificationsConfig,
  deps: OsNotifierDeps = {},
): (notice: OsNotice) => Promise<OsDelivery> {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? runBounded
  return async (notice) => {
    if (!config.enabled) return { delivered: false, reason: "disabled" }
    const plan = planOsNotification(platform, notice)
    if ("skip" in plan) return { delivered: false, reason: plan.skip }
    try {
      const completed = await run(plan.command, plan.args, { timeoutMs: config.timeoutMs })
      return completed.exit === 0
        ? { delivered: true }
        : { delivered: false, reason: "notifier-failed" }
    } catch (error) {
      if (error instanceof ProcessError) {
        if (error.code === "spawn") return { delivered: false, reason: "notifier-unavailable" }
        if (error.code === "timeout") return { delivered: false, reason: "notifier-timeout" }
        return { delivered: false, reason: "notifier-cancelled" }
      }
      // Unknown failure shapes are recorded too: the OS channel never throws
      // into the event stream that produced the notice.
      return { delivered: false, reason: "notifier-failed" }
    }
  }
}

/** Adapts the in-app execution-result Notice to the OS channel: same event,
 * second surface — the app title plus the full notice text. */
export function createOsResultSink(
  config: OsNotificationsConfig,
  deps: OsNotifierDeps = {},
): (notice: Notice) => Promise<OsDelivery> {
  const notify = createOsNotifier(config, deps)
  return async (notice) => notify({ title: "OmO", body: notice.text })
}

/** Composes the primary in-app send with the best-effort OS channel. The OS
 * flight starts immediately but never delays, replaces or fails the primary
 * send: the wrapper's result and rejections are exactly the primary's. */
export function withOsNotifications(
  send: (notice: Notice) => Promise<unknown>,
  os: (notice: Notice) => Promise<OsDelivery>,
): (notice: Notice) => Promise<unknown> {
  return async (notice) => {
    const flight = os(notice)
    void flight.catch(() => {
      // os() never rejects by contract; this only contains a broken implementation.
    })
    return await send(notice)
  }
}
