# ADR 0001: Automatic built-in MCP registration

- Status: Accepted
- Date: 2026-10-14

## Context

OmO recommended the GitHub, Context7 and Skills MCP servers, but users had to copy their entries into host `opencode.jsonc` configuration. That duplicated configuration ownership, made the doctor observe stale files instead of live registrations, and did not satisfy the product requirement that safe defaults be available through `omo.jsonc` alone.

OpenCode V2 exposes a public plugin lifecycle for MCP registration. A plugin may contribute server configurations through `ctx.mcp.transform`, while the host retains connection, authentication, reload and disposal ownership.

## Decision

OmO contributes fixed built-in MCP presets during plugin startup through `ctx.mcp.transform`:

- `skills`, `github` and `context7` are enabled by default.
- `vercel` and `cloudflare` are disabled by default and opt in through `mcp.servers.<name>.disabled: false`.
- `mcp.enabled: false` disables all contributed presets.
- `omo.jsonc` and plugin entry options use the standard OmO merge order; plugin entry options override the shared file.

Registration does not overwrite host configuration. When the host MCP editor already contains a same-named entry, OmO contributes nothing for that name, including when the host entry is `disabled: true`.

Secrets remain outside the configuration files. OmO resolves explicit `{env:NAME}` references before registration. It only attaches implicit GitHub or Context7 credentials to their canonical endpoints. Replacing a remote endpoint discards inherited headers and OAuth settings unless the user explicitly supplies them again. A missing referenced variable disables only that server; diagnostics expose variable names, never values.

The returned registration is disposed with the rest of the plugin lifecycle. The doctor observes live host state through `ctx.mcp.list`, not `mcp.servers` discovered on disk, and reports pending, disabled, failed or needs-auth states without forwarding host error text.

## Consequences

Installing the plugin no longer requires a manual `mcp.servers` block for the built-in presets. The host still owns network processes, OAuth, connection retries and final authority over a same-named entry.

Changing an endpoint intentionally requires its authentication to be restated. This is a compatibility tradeoff that prevents a credential intended for one service from being sent to another endpoint.

The automatic presets do not guarantee third-party authentication. GitHub may still require a valid PAT or an appropriately registered OAuth application, and other remote services may require sign-in through OpenCode's `/mcps` flow.
