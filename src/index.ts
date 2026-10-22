import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import { registerAgents } from "./agents/registry"
import { openBoulderContext } from "./boulder/context"
import { mountBoulder } from "./boulder/tools"
import { loadOmoConfig } from "./config/file"
import { mountModelFallback } from "./config/model-fallback"
import { parseOptions } from "./config/schema"
import type { PlanStepInput } from "./contracts"
import { mountDeepIni } from "./deepini/commands"
import { mountBlockedPanel } from "./diagnostics/tool"
import { diagnose } from "./doctor/diagnose"
import { hostDoctorInputs } from "./doctor/host"
import { mountDoctor } from "./doctor/tool"
import { artifactHashProbe, gitRevisionProbe } from "./evidence/probe"
import { mountRevisionLink } from "./evidence/tool"
import { createGoalCommandService, mountGoal } from "./goal/tools"
import { mountHandoff } from "./handoff/commands"
import { mountHashline } from "./hashline/tools"
import { parseLspOptions } from "./lsp/servers"
import { mountLsp } from "./lsp/tools"
import { MCP_SERVER_IDS } from "./mcp/config"
import { mountMcp } from "./mcp/registry"
import { mountMemory } from "./memory/tools"
import { mountRefactor } from "./refactor/commands"
import { mountRuntime } from "./runtime"
import { mountToolGuards } from "./runtime/tool-guards"
import { mountSessions } from "./sessions/tools"
import { mountSlashCommands } from "./slashcommands/tools"
import { omoConfigHome, omoHome, projectKey, projectStateHome } from "./state/home"
import type { MigrationOutcome } from "./state/migrate"
import { legacyStateDir, migrateLegacyState } from "./state/migrate"
import { mountTeams } from "./teams/tools"
import { mountTerminal, parseTerminalOptions } from "./terminal/commands"
import { mountMonitor } from "./terminal/monitor-tools"
import { mountTodoSync } from "./todo/sync"
import { mountWorktrees } from "./worktrees/tools"

const plugin = Plugin.define({
  id: "shtora.omo",
  async setup(ctx) {
    const input = ctx.options ?? {}
    parseOptions(Object.keys(input).length ? input : { schemaVersion: 1 })
    // Global homes: one install owns every project's state under <home>/projects
    // while the shared omo.jsonc lives in the host configuration directory
    // (omoConfigHome, beside the host's own configuration). The legacy
    // .opencode/omo tree migrates once, here, before any consumer opens a handle.
    const home = omoHome()
    const configHome = omoConfigHome()
    const stateHome = projectStateHome(home, ctx.location.project.canonical)
    mkdirSync(stateHome, { recursive: true })
    let migration: MigrationOutcome
    try {
      migration = migrateLegacyState({
        projectCanonical: ctx.location.project.canonical,
        stateHome,
      })
    } catch (error) {
      // Fail-open: a crashed migration never blocks the plugin; the doctor
      // reports the outcome so the loss is visible instead of silent.
      migration = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        copied: [],
      }
    }
    const models = await ctx.model.list({})
    const config = await loadOmoConfig({
      directory: ctx.location.directory,
      configHome,
      // Pre-config-home installations keep working: their ~/.omo/omo.jsonc is
      // read in place until the new primary exists.
      legacyConfigPath: join(home, "omo.jsonc"),
      overrides: input,
      availableModels: models.data.flatMap((model) => [
        { providerID: model.providerID, modelID: model.id },
        ...Object.keys(model.variants ?? {}).map((variant) => ({
          providerID: model.providerID,
          modelID: model.id,
          variant,
        })),
      ]),
    })
    const options = config.resolved
    const disposers: Array<() => Promise<void>> = []
    let cleanup: Promise<void> | undefined
    const dispose = () =>
      (cleanup ??= (async () => {
        const errors: unknown[] = []
        for (const disposer of disposers.reverse())
          try {
            await disposer()
          } catch (error) {
            errors.push(error)
          }
        if (errors.length) throw new AggregateError(errors, "OmO cleanup failed")
      })())
    try {
      const mcp = await mountMcp(ctx, options.mcp, options.runtime.packageManager, config.path)
      disposers.push(mcp.dispose)
      const mcpRegistration = {
        enabled: options.mcp.enabled,
        disabledServers: MCP_SERVER_IDS.filter((server) => options.mcp.servers[server].disabled),
        problems: mcp.problems,
        skills: mcp.skillsContribution,
      }
      disposers.push(await registerAgents(ctx, options))
      // Reactive model fallback sits right after the profiles so the fail-closed
      // model.request guard stays primary: a fallback only ever selects a model the
      // allowlist already permits, and leaves the host's decision untouched otherwise.
      disposers.push(
        await mountModelFallback(ctx, options.model_fallback, {
          allowedModels: options.allowedModels,
          profiles: options.profiles,
        }),
      )
      // After the agent profiles: /deep-ini tells the model to fan out through the native
      // subagent tool, and that tool resolves the OMO_* profiles by name at call time.
      disposers.push(await mountDeepIni(ctx))
      // Same ordering rationale as /deep-ini: /refactor fans out through the native subagent tool
      // and routes to the OMO_* profiles above, and /handoff agent mode delegates through
      // omo_delegate, so both need the profiles registered before they can be invoked.
      disposers.push(await mountRefactor(ctx))
      const runtime = await mountRuntime(ctx, stateHome, options)
      disposers.push(runtime)
      const todos = await mountTodoSync(ctx, async (sessionID) =>
        runtime.repository.list(await runtime.scopeFor(sessionID)),
      )
      disposers.push(todos)
      disposers.push(await mountHandoff(ctx, todos))
      disposers.push(await mountTeams(ctx, stateHome))
      disposers.push(await mountSessions(ctx))
      // Slash-command surface for the model: opt-in (command_tool_enabled), and the
      // host already owns .opencode/commands discovery — this only exposes the merged
      // registry plus invocation through ctx.session.command.
      disposers.push(await mountSlashCommands(ctx, options.command_tool_enabled))
      disposers.push(await mountWorktrees(ctx))
      disposers.push(await mountToolGuards(ctx, options.hashline_edit, options.tool_guards))
      disposers.push(await mountHashline(ctx, options.hashline_edit))
      disposers.push(
        await mountMemory(ctx, stateHome, options.memory_enabled, options.memory_dream),
      )
      // One boulder store per project: goal continuations summarize the
      // session's live work from the same records the boulder tools edit.
      const boulder = options.goal_enabled
        ? openBoulderContext(stateHome, { projectRoot: ctx.location.project.canonical })
        : undefined
      disposers.push(
        await mountGoal(ctx, stateHome, options.goal_enabled, { work: boulder?.summary }),
      )
      disposers.push(
        await mountBoulder(ctx, stateHome, options.goal_enabled, boulder?.store, {
          projectRoot: ctx.location.project.canonical,
        }),
      )
      disposers.push(await mountLsp(ctx, options.lsp))
      // One diagnosis, two entry points: the omo_doctor tool and the existing
      // omo-doctor command share the same host observations, so they can never
      // disagree about what the environment supports.
      const lspConfig = parseLspOptions(options.lsp, ctx.location.directory)
      disposers.push(
        await mountDoctor(ctx, {
          lsp: lspConfig,
          mcpRegistration,
          packageManager: options.runtime.packageManager,
        }),
      )
      // The blocked-runs panel reads the same status payload omo_status serves,
      // so a panel can never disagree with the status it was derived from. The
      // panel owns no state and resumes nothing.
      disposers.push(
        await mountBlockedPanel(ctx, {
          status: (sessionID) => runtime.services.status(sessionID),
        }),
      )
      // Revision linkage reads plans through the runtime's own repository and
      // scope, so it observes exactly the stored plans the plan tools act on and
      // never opens a second handle on the same SQLite files. The probes are
      // rebuilt per call: they memoize what they observe, and no verdict should
      // outlive the call that produced it.
      const projectRoot = ctx.location.project.canonical
      disposers.push(
        await mountRevisionLink(ctx, {
          loadPlan: async (sessionID, planID) =>
            await runtime.repository.load(await runtime.scopeFor(sessionID), planID),
          listPlans: async (sessionID) =>
            await runtime.repository.list(await runtime.scopeFor(sessionID)),
          probes: (signal) => ({
            resolveRevision: gitRevisionProbe({ cwd: projectRoot, ...(signal ? { signal } : {}) }),
            verifyArtifact: artifactHashProbe({
              projectRoot,
              ...(signal ? { signal } : {}),
            }),
          }),
        }),
      )
      const render = (value: unknown) => JSON.stringify(value, null, 2)
      disposers.push(
        await mountTerminal(
          ctx,
          {
            async plan({ sessionID, text }) {
              const input = JSON.parse(text) as { id: string; steps: PlanStepInput[] }
              return render(await runtime.services.create(sessionID, input.id, input.steps))
            },
            async status({ sessionID }) {
              return render(await runtime.services.status(sessionID))
            },
            async resume({ sessionID, text }) {
              const [planID, stepID] = text.trim().split(/\s+/)
              if (!planID) throw new Error("planID required")
              return render(await runtime.services.resume(sessionID, planID, stepID))
            },
            async cancel({ sessionID, text }) {
              return render(await runtime.services.cancel(sessionID, text.trim() || undefined))
            },
            async compact({ sessionID, text }) {
              const target = text.trim() || undefined
              return render(await runtime.services.compact(sessionID, target))
            },
            async doctor({ sessionID, signal }) {
              // The command keeps reporting the config path and runtime status it
              // always did, and adds the compatibility report beside them. The
              // state section reports where this project's data lives and what
              // the one-shot legacy migration did, so a failed move is visible
              // instead of silent.
              const legacy = legacyStateDir(ctx.location.project.canonical)
              let legacyDisposition = "none"
              if (existsSync(legacy)) legacyDisposition = "present"
              else {
                try {
                  if (
                    readdirSync(dirname(legacy)).some((entry) => entry.startsWith("omo.migrated"))
                  )
                    legacyDisposition = "migrated"
                } catch {
                  // No .opencode directory at all: nothing was ever migrated.
                }
              }
              return render({
                config: config.path,
                ...((await runtime.services.status(sessionID)) as object),
                state: {
                  home,
                  stateHome,
                  projectKey: projectKey(ctx.location.project.canonical),
                  legacy: legacyDisposition,
                  // An omo.jsonc beside a project-local host config is inert;
                  // the one beside the global host config IS the active
                  // configuration since configHome moved there, so it must not
                  // be reported as ignored.
                  ignoredProjectConfig: (() => {
                    const besideHost = join(dirname(config.hostConfigPath), "omo.jsonc")
                    return existsSync(besideHost) && resolve(besideHost) !== resolve(config.path)
                  })(),
                  migration,
                },
                compatibility: await diagnose({
                  ...hostDoctorInputs(ctx, sessionID, {
                    lsp: lspConfig,
                    mcpRegistration,
                    packageManager: options.runtime.packageManager,
                    ...(signal ? { signal } : {}),
                  }),
                }),
              })
            },
            ...(options.goal_enabled ? { goal: createGoalCommandService(stateHome) } : {}),
          },
          parseTerminalOptions(options.terminal ?? { enabled: true }),
        ),
      )
      // Read-only parity surface over the tmux mirror: the tools observe the
      // same live TmuxMonitor instances the terminal commands open above, so
      // they can never disagree with what is actually mirrored.
      disposers.push(await mountMonitor(ctx, { terminal: options.terminal }))
      return dispose
    } catch (error) {
      await dispose()
      throw error
    }
  },
})

export default plugin
