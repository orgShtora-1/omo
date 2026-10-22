import { expect, test } from "bun:test"
import { resolveOptions } from "../../src/config/resolve.js"
import { parseOptions } from "../../src/config/schema.js"
import type { DelegationRequest } from "../../src/contracts.js"
import { createDelegationPolicy } from "../../src/delegation/policy.js"

const profileModel = { providerID: "provider", modelID: "profile" }
const categoryModel = { providerID: "provider", modelID: "category" }
const explicitModel = { providerID: "provider", modelID: "explicit", variant: "fast" }
const options = resolveOptions(
  parseOptions({
    schemaVersion: 1,
    profiles: [{ id: "executor", model: profileModel }],
    categories: [{ id: "implement", agent: "executor", model: categoryModel }],
  }),
)
const catalog = {
  agents: [{ id: "executor", mode: "subagent" as const }],
  models: [profileModel, categoryModel, explicitModel],
  skills: [],
}
const request: DelegationRequest = {
  projectID: "project",
  parentSessionID: "parent",
  taskID: "task",
  route: { kind: "category", id: "implement" },
  prompt: "Implement the scoped fix",
  skills: [],
  background: true,
}

test("explicit model takes precedence over category and profile without losing continuation", () => {
  const policy = createDelegationPolicy(options, catalog)
  expect(policy.resolve({ ...request, explicitModel, sessionID: "child" })).toEqual({
    agentID: "executor",
    model: explicitModel,
    skills: [],
    prompt: request.prompt,
    background: true,
    sessionID: "child",
  })
})

test("category then profile then host defaults determine the model", () => {
  expect(createDelegationPolicy(options, catalog).resolve(request).model).toEqual(categoryModel)
  expect(
    createDelegationPolicy(options, catalog).resolve({
      ...request,
      route: { kind: "agent", id: "executor" },
    }).model,
  ).toEqual(profileModel)
  const defaults = resolveOptions(parseOptions({ schemaVersion: 1 }))
  expect(createDelegationPolicy(defaults, catalog).resolve(request).model).toBeUndefined()
})

test.each([
  ["investigate", "explore"],
  ["implement", "executor"],
  ["review", "reviewer"],
  ["document", "executor"],
  ["validate", "verifier"],
] as const)("default category %s resolves to %s", (id, agentID) => {
  const defaults = resolveOptions(parseOptions({ schemaVersion: 1 }))
  const policy = createDelegationPolicy(defaults, {
    ...catalog,
    agents: [{ id: agentID, mode: "subagent" }],
  })
  expect(policy.resolve({ ...request, route: { kind: "category", id } }).agentID).toBe(agentID)
})

test.each([
  { providerID: "provider", modelID: "missing" },
  { providerID: "provider", modelID: "explicit", variant: "missing" },
  { providerID: "", modelID: "explicit" },
])("an invalid explicit model never falls back to a configured model", (explicitModel) => {
  expect(() =>
    createDelegationPolicy(options, catalog).resolve({ ...request, explicitModel }),
  ).toThrow("model unavailable")
})

test("model rejections list the permitted models so the caller can correct the request", () => {
  const blocked = resolveOptions(
    parseOptions({
      schemaVersion: 1,
      allowedModels: [profileModel],
      agents: { executor: { allowedModels: [profileModel] } },
    }),
  )
  expect(() =>
    createDelegationPolicy(blocked, catalog).resolve({
      ...request,
      route: { kind: "agent", id: "executor" },
      explicitModel,
    }),
  ).toThrow("permitted by allowedModels: provider/profile")
  const agentBlocked = resolveOptions(
    parseOptions({
      schemaVersion: 1,
      allowedModels: [profileModel, explicitModel],
      agents: { executor: { allowedModels: [profileModel] } },
    }),
  )
  expect(() =>
    createDelegationPolicy(agentBlocked, {
      ...catalog,
      models: [...catalog.models, explicitModel],
    }).resolve({
      ...request,
      route: { kind: "agent", id: "executor" },
      explicitModel,
    }),
  ).toThrow("permitted for executor: provider/profile")
  expect(() =>
    createDelegationPolicy(options, catalog).resolve({
      ...request,
      explicitModel: { providerID: "provider", modelID: "missing" },
    }),
  ).toThrow("host offers: provider/profile, provider/category, provider/explicit#fast")
})

test.each([
  [{ kind: "category", id: "toString" }, "unknown category"],
  [{ kind: "agent", id: "missing" }, "unknown agent"],
  [{ kind: "agent", id: "primary" }, "primary-only agent"],
] as const)("invalid routes are rejected before resolution", (route, message) => {
  const policy = createDelegationPolicy(options, {
    ...catalog,
    agents: [...catalog.agents, { id: "primary", mode: "primary" }],
  })
  expect(() => policy.resolve({ ...request, route })).toThrow(message)
})

test("automatic task recommendations are capped and can be disabled without dropping required skills", () => {
  const skills = Array.from({ length: 8 }, (_, i) => ({ id: `skill:${i}`, name: `s${i}` }))
  const taskCatalog = { ...catalog, skills, recommendSkills: () => skills.map((s) => s.id) }
  const configured = resolveOptions(
    parseOptions({ schemaVersion: 1, skills: { required: ["s1"] } }),
  )
  expect(
    createDelegationPolicy(configured, taskCatalog).resolve({ ...request, skills: ["s0"] }).skills,
  ).toEqual(["skill:0", "skill:1", "skill:2", "skill:3", "skill:4", "skill:5", "skill:6"])
  expect(
    createDelegationPolicy(
      { ...configured, skills: { ...configured.skills, auto: false } },
      taskCatalog,
    ).resolve({ ...request, skills: ["s0"] }).skills,
  ).toEqual(["skill:0", "skill:1"])
})

test("an available explicit model cannot escape the configured allowlist", () => {
  const restricted = { ...options, allowedModels: [profileModel, categoryModel] }
  expect(() =>
    createDelegationPolicy(restricted, catalog).resolve({ ...request, explicitModel }),
  ).toThrow("model not permitted")
  expect(createDelegationPolicy(restricted, catalog).resolve(request).model).toEqual(categoryModel)
})
