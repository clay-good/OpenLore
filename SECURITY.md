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

### Served content and the human-review boundary

OpenLore's read-only surfaces protect its stores from mutation. They do not protect a consuming
agent from the text those stores contain. Memories, specifications, decisions, source-derived
strings, imported metadata, and branch or pull-request titles are untrusted input when served.
Deterministic output means the same bytes are returned; it does not mean those bytes are benign.

Human review is the authority boundary. Served fields carry factual origin labels
(`reviewed-corpus`, `local-unreviewed`, `foreign-actor`, `imported`, or `source-derived`), and
composed agent-context blocks frame the original bytes as data rather than instructions. OpenLore
does not sanitize, rewrite, or score the trustworthiness of recorded content.

`openlore doctor` provides an advisory lexical check for common instruction-shaped text. It is
incomplete, can miss unfamiliar phrasing, and can flag benign prose. It helps a human reviewer; it
is not a safety guarantee and does not block by default.

## Automated checks

Every pull request and release runs these:

- **Dependency advisories** — the full tree (runtime and development) is gated at high severity.
- **CodeQL** static analysis on each pull request and on a weekly schedule.
- **Published-package contents** are verified against the real `npm pack` manifest, in CI and again immediately before publish.
- **Workflow hardening** — GitHub Actions are pinned to immutable commit SHAs, and a test in the unit suite keeps them pinned.
- **Dependabot** watches both npm packages and GitHub Actions.
- **OpenSSF Scorecard** tracks supply-chain posture weekly.
- **Releases** are published with npm Trusted Publishing (short-lived OIDC, no long-lived token) and carry a signed `--provenance` attestation tying each tarball to the commit and workflow run that built it.

Two conventions to follow when changing anything under `.github/`:

- **Pin actions to a commit SHA, not a tag**, and keep the trailing `# vX.Y.Z` comment. Resolve one with `gh api repos/<owner>/<repo>/git/ref/tags/<tag> -q .object.sha`.
- **Pass values into a shell through `env:`, never inline `${{ }}`.** Actions expressions are substituted into the script text before the shell parses it, so an inline expression is treated as program rather than as data.
