import { expect, test } from "bun:test"
import { runEvals } from "./runner"
import { LEDGER, SCENARIOS, SUITE_VERSION } from "./scenarios"

const options = { suiteVersion: SUITE_VERSION, ledger: LEDGER, env: process.env }

test("the behavioural eval suite proves every behaviour in the ledger", async () => {
  const report = await runEvals(SCENARIOS, options)
  expect(report.uncovered).toEqual([])
  expect(report.results.filter((item) => item.status !== "pass")).toEqual([])
  expect(report.status).toBe("pass")
})

test("every failing scenario names an observable reason", async () => {
  const report = await runEvals(SCENARIOS, options)
  for (const result of report.results) {
    if (result.status === "pass") continue
    expect(result.detail?.length ?? 0).toBeGreaterThan(0)
  }
})

test("the ledger names each behaviour once so coverage cannot be double counted", () => {
  expect([...LEDGER].sort()).toEqual([...new Set(LEDGER)].sort())
})

test("scenario ids are unique so no scenario can shadow another", () => {
  const ids = SCENARIOS.map((item) => item.id)
  expect([...ids].sort()).toEqual([...new Set(ids)].sort())
})

test("every scenario declares the behaviour it exercises", () => {
  for (const scenario of SCENARIOS) {
    expect(scenario.covers.length, `${scenario.id} declares no coverage`).toBeGreaterThan(0)
    for (const behaviour of scenario.covers) {
      expect(LEDGER as readonly string[], `${scenario.id} covers unknown ${behaviour}`).toContain(
        behaviour,
      )
    }
    expect(scenario.version).toBeGreaterThan(0)
    expect(scenario.title.length).toBeGreaterThan(0)
  }
})

test("no shipped scenario needs paid inference or a live gate by default", () => {
  for (const scenario of SCENARIOS) {
    expect(scenario.requires, `${scenario.id} requires an unauthorized gate`).toBeUndefined()
  }
})
