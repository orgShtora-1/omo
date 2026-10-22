import assert from "node:assert/strict"

// Fixed acceptance contract, independent of the runtime registry under test.
export const smokeAgentIDs = [
  "orchestrator",
  "planner",
  "executor",
  "explore",
  "researcher",
  "reviewer",
  "verifier",
  "sisyphus",
  "hephaestus",
  "prometheus",
  "atlas",
  "oracle",
  "librarian",
  "multimodal-looker",
  "metis",
  "momus",
  "sisyphus-junior",
] as const

type SmokeApi = (path: string) => Promise<{
  data?: { id: string; state?: { status: string } }[]
}>

// Native policies must finish loading before either restore snapshot is taken.
export async function nativeSmokeAgents(api: SmokeApi): Promise<{ id: string }[]> {
  await api("/api/config")
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const plugins = (await api("/api/plugin")).data
    assert(Array.isArray(plugins), "Native plugin catalog is missing")
    assert(
      !plugins.some((plugin) => plugin.state?.status === "error"),
      "Native plugin initialization failed",
    )
    if (plugins.length && plugins.every((plugin) => plugin.state?.status === "active")) {
      const agents = (await api("/api/agent")).data
      assert(
        Array.isArray(agents) && agents.some((agent) => agent.id === "explore"),
        "Native agent baseline was not initialized",
      )
      return agents
    }
    await Bun.sleep(250)
  }
  throw new Error("Native plugins were not active within 20 seconds")
}

export function assertSmokeAgentsRegistered(agents: readonly { id: string }[]): void {
  const ids = agents.map((agent) => agent.id)
  for (const id of smokeAgentIDs)
    assert.equal(
      ids.filter((candidate) => candidate === id).length,
      1,
      `Missing or duplicate ${id}`,
    )
  assert(
    !ids.some((id) =>
      /^omo-(orchestrator|planner|executor|explore|researcher|reviewer|verifier)$/.test(id),
    ),
    "Legacy task profile survived the rename",
  )
}

export function assertSmokeAgentsRestored(
  agents: readonly { id: string }[],
  baseline: readonly { id: string }[],
): void {
  assert.deepEqual(
    agents.map((agent) => agent.id).sort(),
    baseline.map((agent) => agent.id).sort(),
    "Plugin profiles survived native unload",
  )
  assert.deepEqual(
    agents.find((agent) => agent.id === "explore"),
    baseline.find((agent) => agent.id === "explore"),
    "Native explore was not restored on unload",
  )
}
