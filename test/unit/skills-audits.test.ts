import { expect, test } from "bun:test"
import { fetchSkillAudits, summarizeAudits } from "../../src/skills/audits.js"

test("summarizeAudits reports fail when any audit fails", () => {
  expect(
    summarizeAudits({ audits: [{ status: "pass" }, { status: "warn" }, { status: "fail" }] }),
  ).toBe("fail")
  expect(summarizeAudits({ audits: [{ status: "fail" }] })).toBe("fail")
})

test("summarizeAudits reports warn when any audit warns and none fail", () => {
  expect(summarizeAudits({ audits: [{ status: "pass" }, { status: "warn" }] })).toBe("warn")
})

test("summarizeAudits reports pass when every audit passes", () => {
  expect(summarizeAudits({ audits: [{ status: "pass" }, { status: "pass" }] })).toBe("pass")
})

test("summarizeAudits reports unknown for empty, missing, or non-array audits", () => {
  expect(summarizeAudits({ audits: [] })).toBe("unknown")
  expect(summarizeAudits({})).toBe("unknown")
  expect(summarizeAudits({ audits: "nope" })).toBe("unknown")
  expect(summarizeAudits(null)).toBe("unknown")
  expect(summarizeAudits(undefined)).toBe("unknown")
})

test("fetchSkillAudits returns the verdict and audits from a 200 payload", async () => {
  const seen: string[] = []
  const stubFetch = (async (input: string | URL | Request): Promise<Response> => {
    seen.push(String(input))
    return new Response(JSON.stringify({ audits: [{ status: "warn" }] }), { status: 200 })
  }) as typeof fetch
  const result = await fetchSkillAudits("acme/demo", stubFetch)
  expect(result.verdict).toBe("warn")
  expect(result.audits).toHaveLength(1)
  expect(seen).toEqual(["https://skills.sh/api/v1/skills/audit/acme/demo"])
})

test("fetchSkillAudits honors a custom baseUrl", async () => {
  const seen: string[] = []
  const stubFetch = (async (input: string | URL | Request): Promise<Response> => {
    seen.push(String(input))
    return new Response(JSON.stringify({ audits: [{ status: "pass" }] }), { status: 200 })
  }) as typeof fetch
  const result = await fetchSkillAudits("acme/demo/extra", stubFetch, "https://example.test/")
  expect(result.verdict).toBe("pass")
  expect(seen).toEqual(["https://example.test/api/v1/skills/audit/acme/demo/extra"])
})

test("fetchSkillAudits returns unknown with no audits on 404", async () => {
  const stubFetch = (async (): Promise<Response> =>
    new Response("not found", { status: 404 })) as unknown as typeof fetch
  await expect(fetchSkillAudits("acme/missing", stubFetch)).resolves.toEqual({
    verdict: "unknown",
    audits: [],
  })
})

test("fetchSkillAudits throws on non-ok responses", async () => {
  const stubFetch = (async (): Promise<Response> =>
    new Response("boom", { status: 500 })) as unknown as typeof fetch
  await expect(fetchSkillAudits("acme/demo", stubFetch)).rejects.toThrow()
})

test.each(["", "a", "a/b/c/d", "a b/c", "owner/repo!", "/leading", "trailing/"])(
  "fetchSkillAudits throws without fetching for invalid id %s",
  async (skillId) => {
    let called = false
    const stubFetch = (async (): Promise<Response> => {
      called = true
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    await expect(fetchSkillAudits(skillId, stubFetch)).rejects.toThrow()
    expect(called).toBe(false)
  },
)
