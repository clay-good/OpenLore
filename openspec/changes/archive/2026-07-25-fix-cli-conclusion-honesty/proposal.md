# Uniform conclusion honesty across CLI commands: base-ref fallback, staleness, unknown inputs

> Status: SHIPPED (2026-07-18). The honesty disciplines exist — some commands apply
> them, siblings don't. A live dogfood of all ~50 CLI commands found four places where a
> conclusion-shaped command answers confidently over an undisclosed defect in its own inputs,
> while a sibling command discloses the identical defect. This change makes the disciplines
> uniform and adds the guard that keeps a new conclusion command from shipping without them.
> Shipped as one shared `resolveBaseRefDisclosed` helper + the existing staleness boundary,
> adopted across certify-public-surface, impact-certificate, blast-radius, briefing-since, and
> coverage-gaps, plus the style-fingerprint and features fixes and a source-level parity guard.

## The gap (all live-reproduced on this repo, v2.1.5)

1. **Silent base-ref fallback.** `certify-public-surface --base not-a-ref --json` → exit 0,
   `"base": "main"`, overall `"non-breaking"`, **no disclosure** that the requested ref did not
   resolve. Siblings do this right: `blast_radius` and `impact-certificate` emit an explicit
   caveat; `briefing-since` returns a structured `baseRefFallback: {requested, resolved}`. A user
   who typos a release tag gets a clean breaking-change verdict against the wrong base — the
   worst possible failure for a certification tool.
2. **Inconsistent staleness disclosure.** With the index 6 days / 94 files stale, `preflight`
   honestly fails (STALE, score 85) and `certify-public-surface` disclosed the staleness boundary —
   but `blast-radius` (headline: "highest risk: critical") and `briefing-since` returned rich
   conclusions with **no mention that the graph predates the very commits being briefed**.
3. **Quiet-empty on unknown enum input.** `style-fingerprint --language Klingon --json` → exit 0,
   `byLanguage: []`, no explanation — from the tool family whose selling point is "a null signal,
   never a quiet empty." (Its own `--file no/such/file.ts` path does it right: `status:
   "unavailable"`, exit 1.)
4. **Health conflation.** `openlore features` shows Federation as active/healthy ("✓ 2 peer
   repo(s) registered") while `federation list` reports both peers `✗ missing path` — counting
   registry entries as health.

## What changes

1. **One base-ref resolution helper** used by every `--base` command: resolve-or-disclose, with
   the structured `baseRefFallback` shape `briefing-since` already defined. For *certification*
   commands (`certify-public-surface`, `impact-certificate`) an unresolvable requested ref is an
   **error by default** (exit ≠ 0) — a certificate against a base the user didn't ask for is not a
   certificate; `--allow-base-fallback` restores the disclosed-fallback behavior.
2. **One staleness-boundary helper**: every conclusion command that reads the cached graph carries
   the same `staleness` disclosure `certify-public-surface` already emits (index commit, files
   changed since). `blast-radius` and `briefing-since` adopt it.
3. `style-fingerprint --language <unknown>` returns the honest not-found shape (exit 1, known
   languages listed) matching its `--file` path and `get_language_support`.
4. `features` health for federation reflects resolvability (the `federation list` verdicts), not
   registry row count: "2 peers registered, 2 unreachable" is shown as degraded, not ✓.
5. **Parity guard:** a test enumerates every CLI command taking `--base` or reading the cached
   graph and asserts the helper is on its path (the CLAUDE.md MCP↔CLI parity doctrine, applied
   inside the CLI).

## Why this is in scope

These four are the honesty contract's own disciplines, already implemented once each elsewhere in
the codebase; the audit merely found the commands that missed them. Uniformity is the fix, and the
helper-plus-guard shape is how this repo has kept other invariants from regressing.

## Impact

- CLI command modules for the four findings; two small shared helpers; parity guard test.
- Specs: `cli` — 2 ADDED requirements (BaseRefResolutionIsDisclosedOrFatal,
  ConclusionCommandsDiscloseIndexStaleness).
- Risk: certify commands newly erroring on bogus refs is a behavior change — the correct one;
  disclosed in CHANGELOG with the opt-out flag.
