# Tasks — PR-review surface

> Status: IMPLEMENTED (2026-06-23, PR #188). All sections built, tested (src/cli/commands/review.test.ts, 12 tests), and dogfooded on real diffs.
>
> Original: PROPOSED (2026-06-22). Pure orchestration of `structural_diff`, `computeBlastRadius`, and
> `detectDrift`; no new structural computation, no LLM, no new MCP tool. Call `record_decision` before
> coding (new command, the markdown briefing format, the sticky-comment convention, and the
> reuse of the `blastRadius.block` gating config).

## 1. Markdown briefing renderer (composition only)
- [x] Add `renderMarkdown(briefing)` alongside `renderHeadline` / `renderHuman` in
      `src/core/services/mcp-handlers/blast-radius.ts` (or a sibling renderer module), composing the
      structural delta (`handleStructuralDiff`), the blast radius (`computeBlastRadius`), and drift
      (`detectDrift`) for a `base..head` range into one conclusion-shaped Markdown document.
- [x] Output is a briefing (named risks + counts + tests to run), never a graph dump.
- [x] Test: a diff that removes a symbol with live callers and changes another's signature renders
      a briefing naming both, the stale callers, hubs/layers, tests, and any governing decision/spec.

## 2. `openlore review` CLI command
- [x] New `src/cli/commands/review.ts`, registered like `blast-radius` / `drift`. Options:
      `--base <ref>` (default via `resolveBaseRef` fallback chain), `--head <ref>` (default working
      tree), `--format markdown|json` (default `markdown`), `--out <path>`.
- [x] Reuse `getChangedFiles` / `resolveBaseRef` / `validateGitRef` from `src/core/drift/git-diff.ts`;
      follow the `--json` stdout / human-stderr split (`redirectConsoleToStderr`).
- [x] Test: `--format json` emits the composed briefing on stdout, human output on stderr.

## 3. Honest degradation
- [x] No index → briefing states "run `openlore analyze`", not zero changes.
- [x] Unreachable base (shallow checkout) → briefing names the unreachable base and the fallback used.
- [x] Not a git repo / no range → briefing states it could not compute, exits non-error in advisory mode.
- [x] Test: each degraded path emits a disclosure, never a misleading empty briefing.

## 4. Bundled GitHub Action + workflow
- [x] `.github/actions/openlore-review` composite action: checkout (full history), install/build,
      run `openlore review --base <pr.base.sha> --head <pr.head.sha> --format markdown`, post result.
- [x] Sticky comment: find-by-hidden-marker (`<!-- openlore-review -->`), create on first run, update
      in place after, via `GITHUB_TOKEN` + GitHub REST `issues/{n}/comments`. Never duplicate.
- [x] Ship a copy-paste `pull_request` workflow so adoption is one file.
- [x] Advisory by default (exit 0). Opt-in job failure on configured high-severity findings, reusing
      the `.openlore/config.json` `blastRadius.block` pattern convention (no second config dialect).

## 5. Docs
- [x] Document `openlore review` and the Action (install = one workflow file; advisory-by-default;
      opt-in gating) in the README and the CLAUDE.md tool table; note it needs a full-history checkout
      and a prior `openlore analyze` (or an index step in the workflow).
