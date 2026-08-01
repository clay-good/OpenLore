# Fix first-analysis self-contamination: install's own artifacts must not skew the user's repo

> Status: PROPOSED (2026-07-27, first-run e2e). `openlore install` writes `.mcp.json`,
> `AGENTS.md`, and a `CLAUDE.md` block, then immediately analyzes the repo — and counts its own
> just-written files as user code. On a small polyglot repo (3 TS/Python source files) the very
> first analysis reported a garbage domain named `-mcp`, a Languages line with **no Python**
> (displaced by the Markdown/JSON files install itself wrote), and a Python source file that
> belongs to **no domain at all**. The user's first impression of "deterministic structural
> context" is a summary that mis-describes their repo because the tool measured itself.

## The gap

Reproduced end-to-end on a clean repo (`src/index.ts`, `src/payments.ts`, `scripts/report.py`,
plus pre-existing `package.json`/`.gitignore`/`CLAUDE.md`) with `node dist/cli/index.js install`:

- **Install-authored files become a "domain."** Install writes `.mcp.json`, `AGENTS.md`, and the
  managed `CLAUDE.md` block *before* running analyze. The root cluster then contains `.mcp.json`,
  `.gitignore`, `package.json`, `AGENTS.md`, `CLAUDE.md` — three of five files OpenLore-authored —
  and is presented as a detected domain of the user's codebase (summary line: `mcp (5 files)`).
- **The domain name is dotfile garbage, chosen by file order.** The cluster-name fallback derives
  from the *first file's name*: strip extension, lowercase, non-alphanumerics → `-`
  (`src/core/analyzer/dependency-graph.ts:630-633`). `.mcp.json` → `.mcp` → **`-mcp`**. Which
  file is "first" is a scan-order coincidence, so the name is both malformed (leading dash) and
  nondeterministic across repos.
- **The Languages line drops a real language for tool debris.** The summary prints the top 3
  languages by file count (`src/cli/commands/analyze.ts:575`). With install's Markdown and JSON
  files counted, the line reads `TypeScript, JSON, Markdown` — the repo's Python (1 file, 2
  functions, 1 env var, all successfully extracted) is invisible in the first thing the user reads.
- **An analyzed source file can belong to no domain.** `scripts/report.py` is a call-graph node
  and is indexed for search, but appears in no cluster and no domain in `repo-structure.json` —
  it is simply absent from the domain view with no disclosure.

None of the open proposals touch this: `unify-onboarding-entrypoint` is about the install
entrypoint, `refine-first-run-partial-serving` about serving before the index is complete, and
the shipped `refine-happy-path-and-defaults` about presets and epilogues. The analyzer's own
candidate-set rules (hand-authored source only — the `report_coverage_gaps` scope) already
exclude vendored/generated code; they say nothing about files OpenLore itself just wrote.

## What changes

- **Install-authored artifacts are excluded from repo characterization.** Install already knows
  exactly what it wrote — every managed file carries an OpenLore fingerprint (`_openlore.managed`
  in `.mcp.json`, the `openlore-fingerprint` comment in the `CLAUDE.md`/`AGENTS.md` blocks).
  Files that are entirely OpenLore-managed are excluded from domain clustering, language ranking,
  and high-value selection; files that merely *contain* a managed block (a user's real
  `CLAUDE.md`) still count as user files. Detection is by the managed markers, never a hardcoded
  filename list.
- **The domain-name fallback can no longer mint garbage.** A derived name is validated (must
  start alphanumeric); a non-structural cluster of root-level config files is labeled for what it
  is (e.g. `(root config)`) instead of borrowing the first file's name.
- **Every analyzed source file lands in the domain view or is disclosed.** A source file that
  clusters nowhere is reported in an explicit "undomained" list rather than silently absent.

No new artifact, no new tool. This is a candidate-set and presentation fix inside the existing
analyze pipeline.

## Impact

- Affected specs: `analyzer`
- Affected code: `src/core/analyzer/dependency-graph.ts` (cluster naming, membership),
  `src/core/analyzer/repository-mapper.ts` / `artifact-generator.ts` (language ranking,
  key-file selection, domain view), `src/cli/commands/analyze.ts` (summary rendering),
  `src/cli/install/` (expose the managed-file set to the analyzer it invokes)
