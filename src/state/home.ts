import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

export const OMO_HOME_ENV = "OMO_HOME"

/**
 * Global home for every OmO installation (state + config), overridable via
 * the `OMO_HOME` environment variable. An empty override falls back to
 * `~/.omo` so a stray `OMO_HOME=` cannot point the plugin at the filesystem
 * root.
 */
export function omoHome(
  env: Record<string, string | undefined> = process.env,
  osHomedir: () => string = homedir,
): string {
  const override = env[OMO_HOME_ENV]
  if (typeof override === "string" && override.length > 0) return override
  return join(osHomedir(), ".omo")
}

export const OMO_CONFIG_HOME_ENV = "OMO_CONFIG_HOME"

/**
 * Global directory holding OmO's configuration file (omo.jsonc), overridable
 * via the `OMO_CONFIG_HOME` environment variable. Defaults to the host's own
 * configuration directory (`$XDG_CONFIG_HOME/opencode`, else
 * `~/.config/opencode`) so omo.jsonc lives beside the host's opencode.json(c)
 * while runtime state stays in omoHome. An empty override falls back like
 * `OMO_HOME` does.
 */
export function omoConfigHome(
  env: Record<string, string | undefined> = process.env,
  osHomedir: () => string = homedir,
): string {
  const override = env[OMO_CONFIG_HOME_ENV]
  if (typeof override === "string" && override.length > 0) return override
  return join(env.XDG_CONFIG_HOME ?? join(osHomedir(), ".config"), "opencode")
}

/**
 * Stable, filesystem-safe key for a project canonical path. On win32 the
 * whole path is lowercased first (case-insensitive filesystems must map to a
 * single state directory); everywhere else paths are case-sensitive. The key
 * pairs a sanitized slug of the final path segment with a 12-char sha256
 * digest, so distinct projects sharing a basename never collide.
 */
export function projectKey(
  canonical: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = platform === "win32" ? canonical.toLowerCase() : canonical
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 12)
  const segments = normalized.split(/[\\/]+/).filter((segment) => segment.length > 0)
  const last = segments.at(-1) ?? ""
  let slug = last.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "")
  if (slug.length > 32) slug = slug.slice(0, 32)
  if (slug.length === 0) slug = "project"
  return `${slug}-${digest}`
}

/** Per-project state directory inside the global home. */
export function projectStateHome(
  home: string,
  canonical: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(home, "projects", projectKey(canonical, platform))
}
