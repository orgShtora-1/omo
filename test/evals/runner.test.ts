import { expect, test } from "bun:test"
import type { EvalScenario } from "./runner"
import { EvalDeclined, runEvals } from "./runner"

const scenario = (overrides: Partial<EvalScenario> = {}): EvalScenario => ({
  id: "example.one",
  version: 1,
  title: "An example behaviour",
  covers: ["example.behaviour"],
  run: () => {},
  ...overrides,
})

test("a suite whose scenarios all pass reports pass and no uncovered behaviour", async () => {
  const report = await runEvals([scenario()], {
    suiteVersion: 1,
    ledger: ["example.behaviour"],
    env: {},
  })
  expect(report.status).toBe("pass")
  expect(report.uncovered).toEqual([])
  expect(report.results).toHaveLength(1)
  expect(report.results[0]?.status).toBe("pass")
})

test("a scenario that throws is a failure and never a skip", async () => {
  const report = await runEvals(
    [
      scenario({
        run: () => {
          throw new Error("observed divergence")
        },
      }),
    ],
    { suiteVersion: 1, ledger: ["example.behaviour"], env: {} },
  )
  expect(report.status).toBe("fail")
  expect(report.results[0]?.status).toBe("fail")
  expect(report.results[0]?.detail).toBe("observed divergence")
})

test("a rejecting scenario is a failure carrying the rejection reason", async () => {
  const report = await runEvals(
    [
      scenario({
        run: async () => {
          await Promise.reject(new Error("binding did not hold"))
        },
      }),
    ],
    { suiteVersion: 1, ledger: ["example.behaviour"], env: {} },
  )
  expect(report.status).toBe("fail")
  expect(report.results[0]?.detail).toBe("binding did not hold")
})

test("an unmet declared precondition skips the scenario and leaves its behaviour unproven", async () => {
  const report = await runEvals(
    [scenario({ requires: { env: "OMO_EVAL_GATE", note: "needs an authorized gate" } })],
    { suiteVersion: 1, ledger: ["example.behaviour"], env: {} },
  )
  // The behaviour was not exercised, so the suite fails. "The gate was not
  // authorized" is not a weaker form of "the gate holds".
  expect(report.status).toBe("fail")
  expect(report.results[0]?.status).toBe("skipped")
  expect(report.results[0]?.detail).toBe("needs an authorized gate")
  expect(report.uncovered).toEqual(["example.behaviour"])
})

test("a skip that costs no ledger coverage degrades instead of failing", async () => {
  const report = await runEvals(
    [
      scenario({ covers: ["example.behaviour"] }),
      scenario({
        id: "example.optional",
        version: 1,
        title: "An optional extra observation",
        covers: ["example.not-in-ledger"],
        requires: { env: "OMO_EVAL_GATE", note: "needs an authorized gate" },
      }),
    ],
    { suiteVersion: 1, ledger: ["example.behaviour"], env: {} },
  )
  expect(report.status).toBe("degraded")
  expect(report.uncovered).toEqual([])
  expect(report.results[1]?.status).toBe("skipped")
})

test("an unmet declared precondition never invokes the scenario body", async () => {
  let invoked = 0
  const report = await runEvals(
    [
      scenario({
        requires: { env: "OMO_EVAL_GATE", note: "needs an authorized gate" },
        run: () => {
          invoked++
        },
      }),
    ],
    { suiteVersion: 1, ledger: ["example.behaviour"], env: {} },
  )
  expect(invoked).toBe(0)
  expect(report.results[0]?.status).toBe("skipped")
})

test("a declared precondition that is met runs the scenario instead of skipping it", async () => {
  const report = await runEvals(
    [scenario({ requires: { env: "OMO_EVAL_GATE", note: "needs an authorized gate" } })],
    { suiteVersion: 1, ledger: ["example.behaviour"], env: { OMO_EVAL_GATE: "1" } },
  )
  expect(report.status).toBe("pass")
  expect(report.results[0]?.status).toBe("pass")
  expect(report.results[0]?.detail).toBeUndefined()
})

test("declining to run without any declared precondition is a failure", async () => {
  const report = await runEvals(
    [
      scenario({
        run: () => {
          throw new EvalDeclined("no reason recorded")
        },
      }),
    ],
    { suiteVersion: 1, ledger: ["example.behaviour"], env: {} },
  )
  expect(report.status).toBe("fail")
  expect(report.results[0]?.status).toBe("fail")
  expect(report.results[0]?.detail).toContain("declined to run")
  expect(report.results[0]?.detail).toContain("no declared precondition")
})

test("declining to run while its declared precondition is met is a failure", async () => {
  const report = await runEvals(
    [
      scenario({
        requires: { env: "OMO_EVAL_GATE", note: "needs an authorized gate" },
        run: () => {
          throw new EvalDeclined("the body re-checked the gate")
        },
      }),
    ],
    { suiteVersion: 1, ledger: ["example.behaviour"], env: { OMO_EVAL_GATE: "1" } },
  )
  expect(report.status).toBe("fail")
  expect(report.results[0]?.status).toBe("fail")
  expect(report.results[0]?.detail).toContain("declined to run")
  expect(report.results[0]?.detail).toContain("OMO_EVAL_GATE")
})

test("a ledger behaviour with no scenario is uncovered and never reads as pass", async () => {
  const report = await runEvals([scenario({ covers: ["example.behaviour"] })], {
    suiteVersion: 1,
    ledger: ["example.behaviour", "example.uncovered"],
    env: {},
  })
  expect(report.status).toBe("fail")
  expect(report.uncovered).toEqual(["example.uncovered"])
})

test("a behaviour covered only by a skipped scenario is uncovered", async () => {
  const report = await runEvals(
    [
      scenario({
        covers: ["example.gated"],
        requires: { env: "OMO_EVAL_GATE", note: "needs an authorized gate" },
      }),
    ],
    { suiteVersion: 1, ledger: ["example.gated"], env: {} },
  )
  expect(report.uncovered).toEqual(["example.gated"])
})

test("a behaviour covered only by a failed scenario is uncovered", async () => {
  const report = await runEvals(
    [
      scenario({
        covers: ["example.broken"],
        run: () => {
          throw new Error("observed divergence")
        },
      }),
    ],
    { suiteVersion: 1, ledger: ["example.broken"], env: {} },
  )
  expect(report.uncovered).toEqual(["example.broken"])
})

test("a duplicated scenario id is a failure instead of a silent overwrite", async () => {
  const report = await runEvals([scenario(), scenario({ title: "Shadowing duplicate" })], {
    suiteVersion: 1,
    ledger: ["example.behaviour"],
    env: {},
  })
  expect(report.status).toBe("fail")
  expect(report.results).toHaveLength(2)
  expect(report.results[1]?.status).toBe("fail")
  expect(report.results[1]?.detail).toContain("duplicate scenario id")
})

test("an empty suite never reports pass", async () => {
  const report = await runEvals([], { suiteVersion: 1, ledger: [], env: {} })
  expect(report.status).toBe("fail")
  expect(report.results).toEqual([])
})

test("the report names the suite version and every scenario version it observed", async () => {
  const report = await runEvals([scenario({ version: 3 })], {
    suiteVersion: 7,
    ledger: ["example.behaviour"],
    env: {},
  })
  expect(report.schemaVersion).toBe(1)
  expect(report.suiteVersion).toBe(7)
  expect(report.results[0]?.version).toBe(3)
})

test("the report key set is pinned so coverage claims cannot grow quietly", async () => {
  const passing = await runEvals([scenario()], {
    suiteVersion: 1,
    ledger: ["example.behaviour"],
    env: {},
  })
  expect(Object.keys(passing).sort()).toEqual([
    "ledger",
    "results",
    "schemaVersion",
    "status",
    "suiteVersion",
    "uncovered",
  ])
  // A passing result carries no reason: there is nothing to explain.
  expect(Object.keys(passing.results[0] ?? {}).sort()).toEqual([
    "covers",
    "id",
    "status",
    "title",
    "version",
  ])
  const skipped = await runEvals(
    [scenario({ requires: { env: "OMO_EVAL_GATE", note: "needs an authorized gate" } })],
    { suiteVersion: 1, ledger: ["example.behaviour"], env: {} },
  )
  // Every non-pass result states its reason.
  expect(Object.keys(skipped.results[0] ?? {}).sort()).toEqual([
    "covers",
    "detail",
    "id",
    "status",
    "title",
    "version",
  ])
})

test("results keep the declared scenario order so a diff reads as a behaviour diff", async () => {
  const report = await runEvals(
    [scenario({ id: "b.two" }), scenario({ id: "a.one" }), scenario({ id: "c.three" })],
    {
      suiteVersion: 1,
      ledger: ["example.behaviour"],
      env: {},
    },
  )
  expect(report.results.map((item) => item.id)).toEqual(["b.two", "a.one", "c.three"])
})

test("an empty covers list declares no coverage and is reported as uncovered", async () => {
  const report = await runEvals([scenario({ covers: [] })], {
    suiteVersion: 1,
    ledger: ["example.behaviour"],
    env: {},
  })
  expect(report.uncovered).toEqual(["example.behaviour"])
  expect(report.status).toBe("fail")
})

test("a throw that is not an Error still fails with an explicit reason", async () => {
  const report = await runEvals(
    [
      scenario({
        run: () => {
          throw "a bare string"
        },
      }),
    ],
    { suiteVersion: 1, ledger: ["example.behaviour"], env: {} },
  )
  expect(report.status).toBe("fail")
  expect(report.results[0]?.detail).toBe("a bare string")
})
