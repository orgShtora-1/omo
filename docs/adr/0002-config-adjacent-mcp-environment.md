# ADR 0002: Config-adjacent environment for MCP credentials

- Status: Accepted
- Date: 2026-10-17

## Context

The Skills MCP accepts `VERCEL_OIDC_TOKEN` for authenticated actions, but OmO's existing `{env:NAME}` substitution only consulted the host process environment. Users need to keep credentials outside `omo.jsonc` without changing the environment of the whole OpenCode host.

## Decision

Read the literal `.env` beside the selected `omo.jsonc` during MCP setup, before the synchronous public `ctx.mcp.transform` registration. Use the selected configuration path, including the legacy read-only fallback, rather than the project working directory. No new configuration field or dependency is needed.

Parse the file with the runtime's `node:util.parseEnv`, without executing a shell or expanding variable references. Merge a private snapshot with the existing process environment taking precedence, including explicitly empty values. Never mutate `process.env` or persist resolved credentials.

Use this snapshot for the existing MCP reference resolution and canonical GitHub/Context7 credential defaults. Passing the Skills token requires an explicit `mcp.servers.skills.environment.VERCEL_OIDC_TOKEN: "{env:VERCEL_OIDC_TOKEN}"` mapping. Do not forward the entire dotenv file to any subprocess. Host-owned same-named MCP entries remain authoritative.

An absent `.env` preserves current behavior. Other read/parse failures stop setup with a path-only, content-free error. With automatic MCP registration disabled, the file is not read. Existing missing-reference behavior is unchanged: only the affected preset is disabled, and diagnostics contain variable names rather than values.

## Consequences

Secrets can live beside the shared configuration without being stored in JSONC or exported globally. Default public Skills actions remain available without a configured token. Users must explicitly opt into authenticated actions and protect the dotenv file themselves.

The environment is a startup snapshot: changing `.env` requires plugin remount through project reload or host restart, not just MCP transform replay. OmO does not obtain or renew Vercel tokens, and a successful local registration does not prove third-party authorization.
