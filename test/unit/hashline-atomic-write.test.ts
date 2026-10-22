import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { writeAtomic } from "../../src/hashline/atomic"

describe("writeAtomic", () => {
  test("replaces the target file and leaves no temporary residue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omo-atomic-"))
    try {
      const target = join(dir, "file.txt")
      await writeFile(target, "before", "utf8")
      await writeAtomic(target, "after")
      expect(await readFile(target, "utf8")).toBe("after")
      expect(await readdir(dir)).toEqual(["file.txt"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("writes the temporary file next to the target before renaming", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omo-atomic-"))
    try {
      const target = join(dir, "file.txt")
      await writeFile(target, "before", "utf8")
      const written: Array<string> = []
      await writeAtomic(target, "after", {
        writeFile: async (path, data) => {
          written.push(path)
          await writeFile(path, data, "utf8")
        },
      })
      expect(written).toHaveLength(1)
      const tempPath = written[0]
      if (tempPath === undefined) throw new Error("temp path was not captured")
      expect(dirname(tempPath)).toBe(dirname(target))
      expect(basename(tempPath)).toMatch(/^\.file\.txt\.omo-.+\.tmp$/)
      expect(await readFile(target, "utf8")).toBe("after")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("keeps original bytes and removes the temp file when rename fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omo-atomic-"))
    try {
      const target = join(dir, "file.txt")
      await writeFile(target, "before", "utf8")
      await expect(
        writeAtomic(target, "after", {
          rename: async () => {
            throw new Error("rename-denied")
          },
        }),
      ).rejects.toThrow("rename-denied")
      expect(await readFile(target, "utf8")).toBe("before")
      expect(await readdir(dir)).toEqual(["file.txt"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not mask the rename failure when temp cleanup also fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omo-atomic-"))
    try {
      const target = join(dir, "file.txt")
      await writeFile(target, "before", "utf8")
      await expect(
        writeAtomic(target, "after", {
          rename: async () => {
            throw new Error("rename-denied")
          },
          unlink: async () => {
            throw new Error("unlink-denied")
          },
        }),
      ).rejects.toThrow("rename-denied")
      expect(await readFile(target, "utf8")).toBe("before")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
