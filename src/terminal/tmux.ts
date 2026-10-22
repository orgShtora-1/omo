import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProcessError, runBounded } from "../subprocess.js"

class TerminalCapabilityError extends Error {
  readonly code = "capability"
  constructor(message: string) {
    super(message)
    this.name = "TerminalCapabilityError"
  }
}
export interface MonitorRun {
  runID: string
  text: string
}
interface TerminalMonitor {
  open(run: MonitorRun): Promise<void>
  close(runID: string): Promise<void>
  dispose(): Promise<void>
}
export interface TmuxOptions {
  enabled?: boolean
  platform?: NodeJS.Platform
  command?: string
  timeoutMs?: number
  /** Public subprocess seam used for deterministic platform testing. */
  run?: (command: string, args: string[]) => Promise<string>
}

function execute(command: string, args: string[], timeoutMs: number): Promise<string> {
  return runBounded(command, args, { timeoutMs, maxStdout: 65_536, maxStderr: 4_096 }).then(
    (result) => {
      if (result.exit === 0) return result.stdout
      throw new TerminalCapabilityError(`tmux failed (${result.exit}): ${result.stderr}`)
    },
    (error: unknown) => {
      if (error instanceof ProcessError && error.code === "timeout")
        throw new TerminalCapabilityError(`tmux timed out after ${timeoutMs}ms`)
      throw new TerminalCapabilityError(
        `tmux unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    },
  )
}

/** Live monitors, so read-only tools can observe the mirror the terminal commands open. */
const active = new Set<TmuxMonitor>()

/** A private socket and unguessable owner isolate all resources from user tmux. */
export class TmuxMonitor implements TerminalMonitor {
  private owner = randomUUID()
  readonly socketName = `omo-${this.owner}`
  private sessions = new Map<string, { name: string; file: string }>()
  private directory?: string
  private disposed = false
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private options: TmuxOptions = {}) {
    active.add(this)
  }
  private run(args: string[]) {
    const command = this.options.command ?? "tmux"
    return this.options.run
      ? this.options.run(command, args)
      : execute(command, args, this.options.timeoutMs ?? 3000)
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action)
    this.tail = result.catch(() => {})
    return result
  }
  open(run: MonitorRun): Promise<void> {
    return this.serial(async () => {
      if (!this.options.enabled) return
      if (this.disposed) throw new Error("tmux monitor disposed")
      if ((this.options.platform ?? process.platform) === "win32")
        throw new TerminalCapabilityError(
          "tmux requires POSIX; OMO textual commands work on Windows without tmux",
        )
      await this.run(["-V"])
      if (!this.directory) {
        this.directory = await mkdtemp(join(tmpdir(), "omo-tmux-"))
        await writeFile(
          join(this.directory, "monitor.cjs"),
          'const fs=require("node:fs");const file=process.argv[2];let last;setInterval(()=>{try{const text=fs.readFileSync(file,"utf8");if(text!==last){process.stdout.write("\\x1b[2J\\x1b[H"+text+"\\n");last=text}}catch{}},250);',
        )
      }
      const existing = this.sessions.get(run.runID)
      const name =
        existing?.name ?? `run-${createHash("sha256").update(run.runID).digest("hex").slice(0, 24)}`
      const file = existing?.file ?? join(this.directory, `${name}.txt`)
      await writeFile(file, run.text)
      if (existing) return
      await this.run([
        "-L",
        this.socketName,
        "new-session",
        "-d",
        "-s",
        name,
        "--",
        process.execPath,
        join(this.directory, "monitor.cjs"),
        file,
      ])
      // Register immediately so a failed tagging operation cannot orphan a session.
      this.sessions.set(run.runID, { name, file })
      try {
        await this.run(["-L", this.socketName, "set-option", "-t", name, "@omo-owner", this.owner])
      } catch (error) {
        // This exact session was just created on our private socket, before exposure.
        await this.run(["-L", this.socketName, "kill-session", "-t", name])
        this.sessions.delete(run.runID)
        throw error
      }
    })
  }
  close(runID: string): Promise<void> {
    return this.serial(() => this.closeOwned(runID))
  }
  private async closeOwned(runID: string) {
    const session = this.sessions.get(runID)
    if (!session) return
    const owner = await this.run([
      "-L",
      this.socketName,
      "show-options",
      "-t",
      session.name,
      "-v",
      "@omo-owner",
    ])
    if (owner !== this.owner) throw new Error("tmux ownership changed; session preserved")
    await this.run(["-L", this.socketName, "kill-session", "-t", session.name])
    this.sessions.delete(runID)
    await rm(session.file, { force: true })
  }
  dispose(): Promise<void> {
    return this.serial(async () => {
      if (this.disposed && !this.sessions.size) return
      this.disposed = true
      const failures: unknown[] = []
      for (const id of this.sessions.keys()) {
        try {
          await this.closeOwned(id)
        } catch (error) {
          failures.push(error)
        }
      }
      if (!failures.length && this.directory) {
        await rm(this.directory, { recursive: true, force: true })
        this.directory = undefined
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "tmux cleanup preserved sessions whose ownership could not be confirmed",
        )
      active.delete(this)
    })
  }
  /** Read-only availability for the monitor tools; never spawns tmux. */
  availability(): { available: boolean; reason?: string } {
    if (!this.options.enabled) return { available: false, reason: "tmux disabled" }
    if ((this.options.platform ?? process.platform) === "win32")
      return {
        available: false,
        reason: "tmux requires POSIX; OMO textual commands work on Windows without tmux",
      }
    return { available: true }
  }
  /** The sessions this monitor is currently mirroring, keyed by the run they mirror. */
  mirrored(): Array<{ runID: string; name: string }> {
    return [...this.sessions].map(([runID, session]) => ({ runID, name: session.name }))
  }
  /** The most recent mirrored text for one run; unknown runs fail closed. */
  async capture(runID: string): Promise<string> {
    const session = this.sessions.get(runID)
    if (!session) throw new Error(`unknown-session: ${runID}`)
    return readFile(session.file, "utf8")
  }
}

export function activeMonitors(): TmuxMonitor[] {
  return [...active]
}
