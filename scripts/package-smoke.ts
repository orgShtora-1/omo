import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installTimeoutMs, packSmokeTarball, runSmokeCommand } from "./smoke-package"

// Outside-in check: install the actual tarball, then resolve its public export
// from a different project. Run after build; no npm publication is performed.
const directory = await mkdtemp(join(tmpdir(), "omo package smoke "))

try {
  const packed = await packSmokeTarball(directory)
  const files = packed.files.map((file) => file.path)
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/terminal/tui.js",
    "dist/terminal/tui.d.ts",
    "server.ts",
    "tui.ts",
    "README.md",
    "LICENSE",
    "package.json",
    "examples/omo.jsonc",
    "examples/opencode.jsonc",
  ]) {
    if (!files.includes(required)) throw new Error(`Tarball is missing ${required}`)
  }
  for (const file of files) {
    if (
      /^(src|test|sources|\.agents)\/|\.(sqlite|db|log)(-|$)/.test(file) ||
      /^examples\/(options\.json|opencode\.mcp\.jsonc)$/.test(file)
    ) {
      throw new Error(`Unexpected private artifact in tarball: ${file}`)
    }
  }
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "omo-installed-smoke",
      private: true,
      type: "module",
      dependencies: { "@shtora/omo": `file:./${packed.filename}` },
    }),
  )
  await runSmokeCommand([process.execPath, "install", "--ignore-scripts"], {
    cwd: directory,
    timeoutMs: installTimeoutMs,
  })
  const result = await runSmokeCommand(
    [
      process.execPath,
      "--eval",
      `
    const { default: plugin } = await import('@shtora/omo');
    if (typeof plugin.setup !== 'function') throw new Error('Missing plugin setup');
    const { default: tuiPlugin } = await import('@shtora/omo/tui');
    if (typeof tuiPlugin.setup !== 'function' || tuiPlugin.id !== 'shtora.omo.cli')
      throw new Error('Missing native TUI plugin definition');
    const { Host } = await import('@opencode/plugin/host');
    const { fileURLToPath } = await import('node:url');
    const entrypoints = Host.resolve({ directory: fileURLToPath(new URL('./node_modules/@shtora/omo/', import.meta.url)) });
    if (!entrypoints.server) throw new Error('Installed directory has no native V2 server entrypoint');
    if (!entrypoints.tui) throw new Error('Installed directory has no TUI entrypoint');
    console.log('installed public server/TUI exports OK');
  `,
    ],
    { cwd: directory },
  )
  console.log(`${files.length} tarball files inspected; ${result.trim()}`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
