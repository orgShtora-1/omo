# Security Policy

**Last updated:** 2026-10-25  
**Version:** @shtora/omo@0.3.0

---

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.3.x   | ✅ Current         |
| 0.2.x   | ⚠️ Maintenance only |
| 0.1.x   | ⚠️ Maintenance only |
| < 0.1   | ❌ Unsupported     |

---

## Reporting a Vulnerability

We take security seriously. If you discover a vulnerability, please follow these steps:

### 1. Do NOT open a public issue

Public issues can expose vulnerable users before a fix is available.

### 2. Email us

Send a detailed report to **security@shtora.dev** with:

- **Description** of the vulnerability
- **Steps to reproduce** (proof-of-concept preferred)
- **Potential impact** (what an attacker could achieve)
- **Your contact information** (optional, for follow-up)

### 3. What to expect

- **Acknowledgment:** We respond within 48 hours
- **Investigation:** We assess severity and impact within 5 business days
- **Fix timeline:** Critical vulnerabilities fixed within 30 days
- **Disclosure:** Coordinated public disclosure after fix is available

---

## Security Scope

### In Scope

- Agent prompt injection via malicious skill files
- Subprocess command injection
- Worktree path traversal
- SQLite injection via plan data
- MCP server supply chain attacks
- Credential leakage in telemetry
- Concurrency races leading to data corruption

### Out of Scope

- OpenCode host vulnerabilities (report to OpenCode team)
- Third-party dependency vulnerabilities (report via Dependabot/GHSA)
- Social engineering attacks
- Denial of service via legitimate API usage

---

## Security Measures

### Subprocess Bounding

All child processes are spawned with:
- argv-only (no shell interpretation)
- Hard timeouts (default 30s, configurable)
- Output caps (stdout: 64KiB, stderr: 8KiB)
- AbortSignal propagation for cancellation
- SIGKILL cleanup on timeout

### Input Validation

- All config validated with Zod v4 schemas
- Plan data validated against schema before persistence
- Worktree paths validated against canonical repository root
- Evidence artifacts validated for path traversal

### Error Handling

- Centralized error code registry prevents silent failures
- Structured error logging with cause chain preservation
- Diagnostic events with PII redaction
- Crash recovery for worktrees and plans

### Dependency Security

- Single pinned runtime dependency (`@opencode/plugin@2.0.32`)
- No transitive production dependencies
- Regular CVE scanning via CI
- Supply chain audit for skill installations

---

## Security Best Practices for Users

### Configuration

```jsonc
{
  // Pin to exact versions
  "schemaVersion": 1,
  // Enable hashline validation for edits
  "hashline_edit": true,
  // Restrict allowed models
  "allowedModels": [{ "providerID": "anthropic", "modelID": "claude-sonnet-4-20250514" }]
}
```

### Skill Installation

Only install skills from trusted sources:
```sh
# Verify skill audit before installing
omo_skill_audit my-skill
# Install only if audit passes
bunx skills add my-skill
```

### MCP Servers

MCP servers are auto-registered but mutation operations are blocked by default:
```jsonc
{
  "mcp": {
    "servers": {
      "skills": {
        "environment": { "SKILLS_ALLOW_MUTATIONS": "true" }
      }
    }
  }
}
```

---

## Security Incident Response

### Detection

- Automated CVE scanning in CI
- Runtime error telemetry (anonymized)
- User-reported vulnerabilities

### Response

1. **Triage:** Assess severity (Critical/High/Medium/Low)
2. **Reproduce:** Confirm the vulnerability in a clean environment
3. **Fix:** Develop and test the fix
4. **Verify:** Independent security review
5. **Release:** Publish patch with security advisory
6. **Notify:** Inform affected users

### Severity Definitions

| Severity | Response Time | Example |
|----------|---------------|---------|
| Critical | 24 hours | Remote code execution, credential theft |
| High | 72 hours | Path traversal, SQL injection |
| Medium | 7 days | Information disclosure, CSRF |
| Low | 30 days | Informational findings, hardening |

---

## Compliance

### Data Handling

- Telemetry data is anonymized before storage
- No PII stored in plan data or worktree metadata
- Diagnostic events truncated to 2000 characters
- Error redaction removes model IDs and command outputs

### Audit Trail

All security-relevant events are logged:
- Plugin mount/unmount
- Delegation attempts (success/failure)
- Worktree operations (prepare/cleanup/integrate)
- MCP server registration
- Skill installation attempts

---

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [CWE/SANS Top 25](https://cwe.mitre.org/top25/)
- [ npm Advisory Database](https://nodesecurity.io/advisories)
