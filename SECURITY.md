# Security Policy

## Supported versions

OpenLore is distributed on npm as [`openlore`](https://www.npmjs.com/package/openlore). Security fixes are released against the **latest** published version. Please upgrade (`npm install -g openlore@latest`) before reporting an issue to confirm it still reproduces.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately by either:

- Opening a [GitHub security advisory](https://github.com/clay-good/OpenLore/security/advisories/new) (preferred — keeps the report private and tracked), or
- Emailing **hi@claygood.com** with the details below.

Include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal repo or command sequence is ideal).
- The OpenLore version (`openlore --version`), Node.js version, and OS.

## What to expect

- We aim to acknowledge a report within a few business days.
- We will confirm the issue, work on a fix, and keep you updated on progress.
- With your consent, we'll credit you in the release notes once a fix ships.

## Scope notes

OpenLore runs **locally** and is deterministic by design — analysis is pure static analysis with no LLM and no network in the hot path, and no telemetry is sent anywhere by default. Areas especially worth scrutiny: the MCP server surface (`openlore mcp`), the pre-commit decisions gate, and any path that reads untrusted repository contents during `analyze`.
