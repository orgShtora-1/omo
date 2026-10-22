import { join } from "node:path"

export const installTimeoutMs = 300_000

export async function runSmokeCommand(
  command: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; label?: string; timeoutMs?: number },
) {
  const { cwd, env = process.env, label = command[0], timeoutMs = 60_000 } = options
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (timedOut) throw new Error(`${label} timed out after ${timeoutMs}ms: ${stderr || stdout}`)
    if (code !== 0) throw new Error(`${label} exited ${code}: ${stderr || stdout}`)
    return stdout.trim()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Windows npm under WSL resolves POSIX paths against the Windows drive root
 * (`/tmp/x` becomes `C:\tmp\x`). Detects that layout from the resolved npm
 * binary and hands it the mounted UNC form instead; native installs are left
 * untouched.
 */
async function nativePackDestination(destination: string): Promise<string> {
  if (process.platform !== "linux") return destination
  const npm = Bun.which("npm")
  if (!npm || !/^\/mnt\/[a-z]\//i.test(npm)) return destination
  const child = Bun.spawn(["wslpath", "-w", destination], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ])
  const translated = stdout.trim()
  return code === 0 && translated ? translated : destination
}

export async function packSmokeTarball(destination: string, env = process.env) {
  // See nativePackDestination: the tarball itself still appears at `destination`.
  const packDestination = await nativePackDestination(destination)
  const output = await runSmokeCommand(
    [
      process.platform === "win32" ? "npm.cmd" : "npm",
      "pack",
      "--json",
      "--ignore-scripts",
      // A publish dry-run is inherited by lifecycle scripts; this local install
      // check still needs a physical tarball. No registry write is performed.
      "--dry-run=false",
      "--pack-destination",
      packDestination,
    ],
    { cwd: process.cwd(), env },
  )
  const [packed] = JSON.parse(output) as {
    name: string
    version: string
    filename: string
    files: { path: string }[]
  }[]
  if (!packed?.filename || !Array.isArray(packed.files))
    throw new Error("npm pack did not report a tarball with a file list")
  if (!(await Bun.file(join(destination, packed.filename)).exists()))
    throw new Error(`npm pack reported ${packed.filename}, but the tarball does not exist`)
  return packed
}
