import { expect, test } from "bun:test"
import { resolveOptions } from "../../src/config/resolve"
import { parseOptions } from "../../src/config/schema"

test("MCP defaults enable skills, github and context7 while cloud services remain opt-in", () => {
  const options = resolveOptions(parseOptions({ schemaVersion: 1 }))
  expect(options.mcp).toEqual({
    enabled: true,
    servers: {
      skills: { disabled: false },
      github: { disabled: false },
      context7: { disabled: false },
      vercel: { disabled: true },
      cloudflare: { disabled: true },
    },
  })
})

test("remote URL values may be supplied through explicit environment references", () => {
  const options = parseOptions({
    schemaVersion: 1,
    mcp: { servers: { github: { url: "{env:OMO_TEST_MCP_URL}" } } },
  })
  expect(options.mcp?.servers?.github?.url).toBe("{env:OMO_TEST_MCP_URL}")
})

test("omo.jsonc can disable automatic registration and override individual built-ins", () => {
  const options = resolveOptions(
    parseOptions({
      schemaVersion: 1,
      mcp: {
        enabled: false,
        servers: {
          skills: {
            command: ["bun", "local-skills.ts"],
            environment: { KEY: "{env:KEY}" },
            protocol: "legacy",
          },
          github: {
            disabled: true,
            url: "https://github.example/mcp",
            headers: { Authorization: "Bearer {env:TOKEN}" },
            oauth: false,
          },
          vercel: { disabled: false, oauth: { client_id: "client" }, timeout: { startup: 5000 } },
        },
      },
    }),
  )
  expect(options.mcp.enabled).toBe(false)
  expect(options.mcp.servers.skills).toMatchObject({
    command: ["bun", "local-skills.ts"],
    disabled: false,
    protocol: "legacy",
  })
  expect(options.mcp.servers.github).toMatchObject({
    disabled: true,
    headers: { Authorization: "Bearer {env:TOKEN}" },
    oauth: false,
  })
  expect(options.mcp.servers.vercel).toMatchObject({
    disabled: false,
    oauth: { client_id: "client" },
    timeout: { startup: 5000 },
  })
  expect(options.mcp.servers.context7.disabled).toBe(false)
})

test.each([
  [{ enabled: "yes" }, "mcp.enabled"],
  [{ surprise: true }, "mcp.surprise"],
  [{ servers: [] }, "mcp.servers"],
  [{ servers: { typo: {} } }, "mcp.servers.typo"],
  [{ servers: { github: { disabled: "false" } } }, "mcp.servers.github.disabled"],
  [{ servers: { skills: { command: [] } } }, "mcp.servers.skills.command"],
  [{ servers: { skills: { url: "https://wrong.example" } } }, "mcp.servers.skills.url"],
  [{ servers: { github: { environment: {} } } }, "mcp.servers.github.environment"],
  [{ servers: { github: { url: "file:///secret" } } }, "mcp.servers.github.url"],
  [{ servers: { github: { protocol: ["legacy"] } } }, "mcp.servers.github.protocol"],
  [
    { servers: { github: { headers: { Authorization: 1 } } } },
    "mcp.servers.github.headers.Authorization",
  ],
  [{ servers: { github: { oauth: true } } }, "mcp.servers.github.oauth"],
  [{ servers: { github: { oauth: { typo: "x" } } } }, "mcp.servers.github.oauth.typo"],
  [{ servers: { github: { timeout: { startup: -1 } } } }, "mcp.servers.github.timeout.startup"],
  [{ servers: { github: { protocol: "future" } } }, "mcp.servers.github.protocol"],
] as const)("invalid MCP configuration %j is rejected at %s", (mcp, path) => {
  expect(() => parseOptions({ schemaVersion: 1, mcp })).toThrow(path)
})
