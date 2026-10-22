import { describe, expect, test } from "bun:test"
import { ensureSkillCoverage } from "../../src/skills/ensure.js"

const merged = [{ id: "skill-debug", name: "debug", description: "Debug runtime failures" }]

describe("ensureSkillCoverage (RED)", () => {
  test("no action when catalog already matches", async () => {
    let searched = 0
    const result = await ensureSkillCoverage({
      prompt: "Debug runtime scheduler failures",
      routeID: "implement",
      merged,
      hostIds: ["skill-debug"],
      autoInstall: true,
      requireAuditPass: true,
      strictAudits: false,
      search: async () => {
        searched++
        return []
      },
      getAudits: async () => ({ verdict: "pass" as const, audits: [] }),
      install: async () => "installed" as const,
    })
    expect(result.installedSkills).toEqual([])
    expect(result.note).toBeUndefined()
    expect(searched).toBe(0)
  })

  test("disabled flag short-circuits with note", async () => {
    let searched = 0
    const result = await ensureSkillCoverage({
      prompt: "entirely unrelated xyzzy prompt with no token overlap",
      routeID: "implement",
      merged: [{ id: "zzz", name: "zzz-name", description: "zzz desc" }],
      hostIds: ["zzz"],
      autoInstall: false,
      requireAuditPass: true,
      strictAudits: false,
      search: async () => {
        searched++
        return []
      },
      getAudits: async () => ({ verdict: "pass" as const, audits: [] }),
      install: async () => "installed" as const,
    })
    expect(result.installedSkills).toEqual([])
    expect(result.note).toBe("auto-install disabled")
    expect(searched).toBe(0)
  })

  test("refused-audit on fail verdict when guard required", async () => {
    const result = await ensureSkillCoverage({
      prompt: "entirely unrelated xyzzy prompt with no token overlap",
      routeID: "implement",
      merged: [{ id: "zzz", name: "zzz-name", description: "zzz desc" }],
      hostIds: ["zzz"],
      autoInstall: true,
      requireAuditPass: true,
      strictAudits: false,
      search: async () => [{ source: "obra/superpowers", slug: "tdd" }],
      getAudits: async () => ({ verdict: "fail" as const, audits: [{ status: "fail" }] }),
      install: async () => {
        throw new Error("must not install on refused audit")
      },
    })
    expect(result.installedSkills).toEqual([
      { id: "tdd", source: "obra/superpowers", outcome: "refused-audit" },
    ])
  })

  test("install-failed on runner error", async () => {
    const result = await ensureSkillCoverage({
      prompt: "entirely unrelated xyzzy prompt with no token overlap",
      routeID: "implement",
      merged: [{ id: "zzz", name: "zzz-name", description: "zzz desc" }],
      hostIds: ["zzz"],
      autoInstall: true,
      requireAuditPass: true,
      strictAudits: false,
      search: async () => [{ source: "obra/superpowers", slug: "tdd" }],
      getAudits: async () => ({ verdict: "pass" as const, audits: [] }),
      install: async () => "install-failed" as const,
    })
    expect(result.installedSkills).toEqual([
      { id: "tdd", source: "obra/superpowers", outcome: "install-failed" },
    ])
  })

  test("search-empty when search returns no hits", async () => {
    const result = await ensureSkillCoverage({
      prompt: "entirely unrelated xyzzy prompt with no token overlap",
      routeID: "implement",
      merged: [{ id: "zzz", name: "zzz-name", description: "zzz desc" }],
      hostIds: ["zzz"],
      autoInstall: true,
      requireAuditPass: true,
      strictAudits: false,
      search: async () => [],
      getAudits: async () => ({ verdict: "pass" as const, audits: [] }),
      install: async () => "installed" as const,
    })
    expect(result.installedSkills).toHaveLength(1)
    expect(result.installedSkills[0]?.outcome).toBe("search-empty")
  })

  test("never throws on search/audit exceptions", async () => {
    const onSearchThrow = await ensureSkillCoverage({
      prompt: "entirely unrelated xyzzy prompt with no token overlap",
      routeID: "implement",
      merged: [{ id: "zzz", name: "zzz-name", description: "zzz desc" }],
      hostIds: ["zzz"],
      autoInstall: true,
      requireAuditPass: true,
      strictAudits: false,
      search: async () => {
        throw new Error("search boom")
      },
      getAudits: async () => ({ verdict: "pass" as const, audits: [] }),
      install: async () => "installed" as const,
    })
    expect(onSearchThrow.installedSkills[0]?.outcome).toBe("search-empty")

    const onAuditThrow = await ensureSkillCoverage({
      prompt: "entirely unrelated xyzzy prompt with no token overlap",
      routeID: "implement",
      merged: [{ id: "zzz", name: "zzz-name", description: "zzz desc" }],
      hostIds: ["zzz"],
      autoInstall: true,
      requireAuditPass: true,
      strictAudits: false,
      search: async () => [{ source: "obra/superpowers", slug: "tdd" }],
      getAudits: async () => {
        throw new Error("audit boom")
      },
      install: async () => "installed" as const,
    })
    // Audit failure must not refuse silently: proceed to install attempt.
    expect(["installed", "install-failed"]).toContain(
      onAuditThrow.installedSkills[0]?.outcome ?? "missing",
    )
  })

  test("strict audits refuse warn and unknown verdicts when the audit guard is required", async () => {
    for (const verdict of ["warn", "unknown"] as const) {
      const result = await ensureSkillCoverage({
        prompt: "entirely unrelated xyzzy prompt with no token overlap",
        routeID: "implement",
        merged: [{ id: "zzz", name: "zzz-name", description: "zzz desc" }],
        hostIds: ["zzz"],
        autoInstall: true,
        requireAuditPass: true,
        strictAudits: true,
        search: async () => [{ source: "obra/superpowers", slug: "tdd" }],
        getAudits: async () => ({ verdict, audits: [{ status: "fail" }] }),
        install: async () => {
          throw new Error("must not install on refused audit")
        },
      })
      expect(result.installedSkills).toEqual([
        { id: "tdd", source: "obra/superpowers", outcome: "refused-audit" },
      ])
    }
  })

  test("strict audits only refuse when the audit guard is required", async () => {
    const result = await ensureSkillCoverage({
      prompt: "entirely unrelated xyzzy prompt with no token overlap",
      routeID: "implement",
      merged: [{ id: "zzz", name: "zzz-name", description: "zzz desc" }],
      hostIds: ["zzz"],
      autoInstall: true,
      requireAuditPass: false,
      strictAudits: true,
      search: async () => [{ source: "obra/superpowers", slug: "tdd" }],
      getAudits: async () => ({ verdict: "unknown" as const, audits: [] }),
      install: async () => "installed" as const,
    })
    expect(result.installedSkills).toEqual([
      { id: "tdd", source: "obra/superpowers", outcome: "installed" },
    ])
  })
})
