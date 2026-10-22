import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseEnv } from "node:util"
import { OptionsError } from "./schema"

/** Resolve MCP references against the selected config's .env without changing the host environment. */
export async function loadConfigEnvironment(configPath: string): Promise<NodeJS.ProcessEnv> {
  const environment = { ...process.env }
  const path = join(dirname(configPath), ".env")
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return environment
    throw new OptionsError(path, "could not read MCP environment file")
  }
  try {
    return { ...parseEnv(source), ...environment }
  } catch {
    // Parser errors must never echo file contents or credential values.
    throw new OptionsError(path, "could not parse MCP environment file")
  }
}
