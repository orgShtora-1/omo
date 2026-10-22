import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  OMO_CONFIG_HOME_ENV,
  OMO_HOME_ENV,
  omoConfigHome,
  omoHome,
  projectKey,
  projectStateHome,
} from "../../src/state/home"

describe("omoHome", () => {
  test("resolves to ~/.omo by default", () => {
    expect(omoHome({}, () => "/home/tester")).toBe(join("/home/tester", ".omo"))
  })

  test("prefers a non-empty OMO_HOME override", () => {
    expect(omoHome({ OMO_HOME: "/custom/state" }, () => "/home/tester")).toBe("/custom/state")
  })

  test("ignores an empty OMO_HOME override", () => {
    expect(omoHome({ OMO_HOME: "" }, () => "/home/tester")).toBe(join("/home/tester", ".omo"))
  })

  test("exports the env var name", () => {
    expect(OMO_HOME_ENV).toBe("OMO_HOME")
  })
})

describe("omoConfigHome", () => {
  test("resolves to the opencode config directory by default", () => {
    expect(omoConfigHome({}, () => "/home/tester")).toBe(
      join("/home/tester", ".config", "opencode"),
    )
  })

  test("prefers XDG_CONFIG_HOME when set", () => {
    expect(omoConfigHome({ XDG_CONFIG_HOME: "/xdg" }, () => "/home/tester")).toBe(
      join("/xdg", "opencode"),
    )
  })

  test("prefers a non-empty OMO_CONFIG_HOME override", () => {
    expect(omoConfigHome({ OMO_CONFIG_HOME: "/custom/config" }, () => "/home/tester")).toBe(
      "/custom/config",
    )
  })

  test("ignores an empty OMO_CONFIG_HOME override", () => {
    expect(omoConfigHome({ OMO_CONFIG_HOME: "" }, () => "/home/tester")).toBe(
      join("/home/tester", ".config", "opencode"),
    )
  })

  test("exports the env var name", () => {
    expect(OMO_CONFIG_HOME_ENV).toBe("OMO_CONFIG_HOME")
  })
})

describe("projectKey", () => {
  test("combines a sanitized slug with a 12-char hash", () => {
    expect(projectKey("/tmp/work/my-project", "linux")).toMatch(/^my-project-[0-9a-f]{12}$/)
  })

  test("is stable for the same canonical path", () => {
    expect(projectKey("/tmp/work/my-project", "linux")).toBe(
      projectKey("/tmp/work/my-project", "linux"),
    )
  })

  test("is case-insensitive on win32 (slug and hash)", () => {
    expect(projectKey("C:\\Work\\OmO", "win32")).toBe(projectKey("c:\\work\\omo", "win32"))
    expect(projectKey("C:\\Work\\OmO", "win32")).toMatch(/^omo-[0-9a-f]{12}$/)
  })

  test("is case-sensitive outside win32", () => {
    expect(projectKey("/work/OmO", "linux")).not.toBe(projectKey("/work/omo", "linux"))
  })

  test("sanitizes unsafe characters in the slug", () => {
    expect(projectKey("/tmp/weird name!", "linux")).toMatch(/^weird-name-[0-9a-f]{12}$/)
  })

  test("truncates long slugs to 32 characters", () => {
    const key = projectKey(`/${"a".repeat(64)}`, "linux")
    expect(key).toMatch(/^a{32}-[0-9a-f]{12}$/)
  })

  test("falls back to a generic slug when the path has no usable segment", () => {
    expect(projectKey("/", "linux")).toMatch(/^project-[0-9a-f]{12}$/)
  })

  test("uses the final non-empty path segment on both separators", () => {
    expect(projectKey("C:\\Users\\dev\\repo", "win32")).toMatch(/^repo-[0-9a-f]{12}$/)
  })
})

describe("projectStateHome", () => {
  test("nests the project key under projects/", () => {
    const canonical = "/tmp/work/my-project"
    expect(projectStateHome("/state", canonical, "linux")).toBe(
      join("/state", "projects", projectKey(canonical, "linux")),
    )
  })
})
