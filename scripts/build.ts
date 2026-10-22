import { rm } from "node:fs/promises"

// Build do package: bundle ESM em dist/index.js e dist/terminal/tui.js + declarações .d.ts.
// SDKs do host ficam externos ao bundler (sem cópias conflitantes).
// Avoid shipping declarations left behind by removed source modules.
await rm("dist", { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/terminal/tui.ts"],
  outdir: "dist",
  format: "esm",
  target: "bun",
  external: ["@opencode/plugin", "@opencode/client", "@opencode/schema", "effect"],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const decl = Bun.spawnSync({
  cmd: ["bunx", "--bun", "tsc", "-p", "tsconfig.build.json"],
  stdout: "inherit",
  stderr: "inherit",
})
if (decl.exitCode !== 0) process.exit(decl.exitCode ?? 1)

console.log("build ok: dist/index.js + dist/terminal/tui.js + .d.ts")
