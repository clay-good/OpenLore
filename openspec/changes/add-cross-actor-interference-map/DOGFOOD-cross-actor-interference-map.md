# Dogfood — `map_in_flight_conflicts`

Run against this repo on 2026-06-24, from `feat/cross-actor-interference-map`, base `main`.
The tool was driven through its real default providers (git for branches, `gh` for PRs) — no mocks.

## Branches (real overlap, correctly flagged)

Input: `branches: [feat/change-footprint-projection, feat/parallel-work-plan, feat/footprint-escape-detection]`,
`includePullRequests: false`.

```
HEADLINE: 2 in-flight change(s); 1 conflict pair(s); 1 write-write (must serialize); 1 not assessed.
repos: [ 'this-repo' ] | assessed: 2 | notAssessed: 1

CHANGES:
  [branch] feat/change-footprint-projection by sim — NOT ASSESSED (no-resolvable-symbols)
  [branch] feat/footprint-escape-detection by sim — 2 symbols / 22 files
  [branch] feat/parallel-work-plan by sim — 1 symbols / 28 files

CONFLICTS: 1
  WAW: feat/footprint-escape-detection × feat/parallel-work-plan
    witnesses: dispatchTool
    -> feat/footprint-escape-detection and feat/parallel-work-plan both modify dispatchTool —
       land one, then rebase the other onto it; do not edit concurrently.

FINDINGS: 1
  [cross-actor-conflict] feat/footprint-escape-detection (sim) × feat/parallel-work-plan (sim)
```

**Verdict — true positive.** Both branches add a dispatch case to `dispatchTool` in
`src/core/services/tool-dispatch.ts`; one also modifies an existing case (footprint-escape passes
`declaredFootprint` to the `structural_diff` case), so the shared symbol is a `modify` on at least one
side → WAW. These two genuinely conflict at merge in that function.

**Verdict — honest "not assessed".** `feat/change-footprint-projection`'s diff vs `main` is almost
entirely *new* files (the proposal-1 library + tests + proposal docs), so it touches no base symbol the
index can resolve. The tool labels it `not-assessed (no-resolvable-symbols)` rather than reporting a
false "no conflict" — exactly the honesty contract the proposal requires.

## Open PRs via `gh` (same overlap, end-to-end)

Input: `includeBranches: false`, `includePullRequests: true`, `maxChanges: 6`.

```
HEADLINE: 2 in-flight change(s); 1 conflict pair(s); 1 write-write (must serialize); 1 not assessed.

CHANGES (PRs):
  [pull-request] PR #199 by clay-good — NOT ASSESSED (no-resolvable-symbols)
  [pull-request] PR #200 by clay-good — 3 symbols / 39 files
  [pull-request] PR #201 by clay-good — 10 symbols / 21 files

CONFLICTS: 1
  WAW: PR #200 × PR #201 [dispatchTool]

CAVEATS:
  - PR diffs are read against the LOCAL base ref; if a PR's base has advanced past local, its hunk
    line mapping is approximate. Re-fetch the base for an exact result.
```

**Verdict.** The `gh` enumeration path works end-to-end and reproduces the same correct WAW
(PR #200 × #201 on `dispatchTool`), with PR #199 honestly "not assessed". The local-base caveat is
disclosed rather than silently assumed.

## What this exercised

- branch enumeration + merge-base diff + per-changed-file base-snapshot re-parse + hunk→symbol mapping;
- the observed-`writeMode` path (the `modify` on `dispatchTool` came from a real deletion-bearing hunk);
- `gh pr list` + `gh pr diff` enumeration and parsing;
- the "not assessed" honesty contract on a real all-new-files change;
- deterministic, conclusion-shaped output with the standing ground-truth disclosure.

## Post-review re-dogfood (after the PR #202 hardening)

Re-ran the `gh` PR path once PR #202 itself was open, so the graph now has four PRs:

```
WAW:           PR #200 × PR #201 [dispatchTool]        (true conflict — both edit the dispatcher)
shared-append: PR #200 × PR #202 [sourceDefaultClass]  (both APPEND a finding code to FINDING_CODE_REGISTRY)
soft-coupling: PR #201 × PR #202 [src/cli/commands/mcp.ts]  (co-change, no call edge — advisory)
PR #199: NOT ASSESSED (no-resolvable-symbols)
```

This is the registry-collision-resolution feature proving itself on **real PRs**: #200 and #202 each
add a distinct entry to `FINDING_CODE_REGISTRY` (`parallel-work-*` vs `cross-actor-conflict`), and the
tool correctly resolves that to **`shared-append`**, not a false WAW — exactly because the per-symbol
`writeMode` is observed from the diff (pure-insertion → append), no declaration needed.

## Hardening from the adversarial review (PR #202)

A multi-agent adversarial review surfaced bugs; all fixed and regression-tested in
`interference-map.test.ts`:

- **C1 (critical):** a deleted line whose *content* starts with dashes (a SQL `-- comment`, a Markdown
  `---` rule, a row of `------`) was misclassified as a non-deletion, silently downgrading a real WAW
  to a "safe" `shared-append`. The parser is now position-aware: inside a hunk, body lines are
  classified by their first character only. Regression tests added.
- **M3:** cross-repo WAR compared repo-local file paths → a coincidental shared relative path
  (`src/index.ts` in both repos) raised a false same-file overlap. File paths are now namespaced per
  repo in the stable-id projection.
- **M2:** cross-repo matching is by signature-shape stable id (name + arity), which can collide on a
  homonym across repos. Added an explicit caveat on every cross-repo conflict and documented the limit.
- **M4:** a home-resolved base ref that doesn't exist in a federated target silently skipped all its
  branches. The base ref is now re-resolved per repo.
- **m5/m6:** tasks dropped by the `maxChanges` cap (and malformed descriptors) now emit a caveat; an
  edit inside a nested function is attributed to the innermost enclosing symbol, not also its parent.

New adversarial tests also cover the previously-untested hazard classes that the tool fully supports:
RAW (with direction), WAR, soft-coupling (via the change-coupling store), the `maxChanges` cap, the
response-size truncation backstop, the federation-unbound degrade, and an empty repo.

## Round-2 hardening (real-git e2e review)

A second review pass with a **real-git e2e harness** (throwaway repos, real `openlore analyze`, real
git/`gh` providers — no mocks) found a structural false-negative the mocked unit tests could not see,
plus I/O-path bugs. All fixed and regression-tested (10 new tests; real-git e2e for the two structural ones):

- **FINDING 1 (false-negative, confirmed on real git):** a branch that **renamed and edited** a function
  reported "no conflict" against a branch editing that function **in place** — a textbook merge conflict
  missed. Cause: the base snapshot was parsed under the file's NEW path, so the renamed symbol's id
  (`new/path::compute`) didn't match the in-place editor's (`old/path::compute`). Fix: parse base content
  under the **base path** (`oldPath ?? path`), so a renamed symbol keeps its base identity. Real-git e2e
  now reports `WAW [compute]` correctly.
- **M-B (flagship gap):** a top-level **registry array/object literal** carries no function node, so two
  PRs appending disjoint entries to it produced no member (the headline "two PRs append to a registry"
  case, for arrays rather than function dispatchers). Fix: a module-scope **pure-insertion** hunk falls
  back to a file-scope write member → `shared-append`. Real-git e2e: two appends to `const TOOLS = [...]`
  → `shared-append [reg.ts]`, no false WAW. (Module-scope *modifies* are intentionally not file-scoped,
  to avoid over-coupling — verified the re-dogfood adds only `shared-append` advisories, never a false WAW.)
- **M-A:** a per-file `git show` failure was conflated with an empty file and silently dropped that file's
  symbols (a potential false "no conflict"). Now distinguished (`null` vs `''`) and disclosed as a caveat.
- **C1 (CRLF):** a CRLF-terminated `diff --git`/`+++` header could corrupt the parsed path (binary/rename
  entries) → a trailing `\r` is now stripped from structural lines.
- **FINDING 2:** with `gh` installed but no GitHub remote, the "PR diffs read against local base" caveat
  fired even though zero PRs were enumerated — now it says "gh installed but no open PRs enumerated" and
  the local-base caveat fires only when PRs were actually assessed.

Re-dogfooded on this repo post-fix: branches still flag the `dispatchTool` WAW; PRs now show the richer
(correct) graph — `WAW #200×#201 [dispatchTool]`, `shared-append #200×#202` (both append to `mcp.ts` /
test files / the finding registry), `RAW #201×#202` (shared test infra) — with **no false WAW** from the
file-scope fallback.
