import { randomUUID } from "node:crypto"
import { rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

export type AtomicWriteDeps = {
  writeFile?: (path: string, data: string) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
  unlink?: (path: string) => Promise<void>
}

/**
 * Write `content` to `filePath` through a same-directory temporary file plus
 * an atomic rename, so a crash mid-write can never truncate the target: the
 * original bytes stay in place until the rename succeeds. A failed rename
 * keeps the original untouched and removes the temporary file best-effort,
 * rethrowing the original error.
 */
export async function writeAtomic(
  filePath: string,
  content: string,
  deps: AtomicWriteDeps = {},
): Promise<void> {
  const write = deps.writeFile ?? ((path: string, data: string) => writeFile(path, data, "utf8"))
  const move = deps.rename ?? rename
  const remove = deps.unlink ?? unlink
  const temp = join(dirname(filePath), `.${basename(filePath)}.omo-${randomUUID()}.tmp`)
  await write(temp, content)
  try {
    await move(temp, filePath)
  } catch (error) {
    await remove(temp).catch(() => {})
    throw error
  }
}
