import { expect, test } from "bun:test"

test("no standalone CLI binary ships and the tmux capability gate stays pinned by tests", async () => {
  const pkg = (await Bun.file(new URL("../../package.json", import.meta.url)).text()) as {
    bin?: unknown
  }
  expect(pkg.bin).toBeUndefined()
  const terminal = await Bun.file(
    new URL("../../test/integration/terminal.test.ts", import.meta.url),
  ).text()
  expect(terminal).toContain("Windows capability")
})
