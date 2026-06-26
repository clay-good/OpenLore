# Changelog

All notable changes to OpenLore are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Public API surface contract — `certify_public_surface`** (FEATURE-UPDATES proposal 2) — certify
  whether a working-tree diff breaks the package's exported contract. With no base ref the tool returns
  the **public surface** (exported symbols + signatures); with a base ref it returns a deterministic
  **breaking-change verdict** — each changed export classified `breaking` / `non-breaking` /
  `potentially-breaking` (removed/renamed export, added required param, narrowed param/return type,
  reduced visibility), each breaking one paired with the **in-repo consumers it breaks**, plus an
  overall summary. **Conservative by construction**: a change it cannot *prove* compatible is
  `potentially-breaking`, never silently safe — no type checker, no build. A renamed export is reported
  as a rename (not remove+add) via symbol-identity continuity; external/unindexed consumers are
  disclosed as a known-unknowable boundary. Signature classification covers TypeScript/JavaScript/Python
  (others fail-soft to surface membership). Distinct from `change_impact_certificate` (paths *into* a
  surface) — this certifies the exported contract's *shape*. Opt-in `certify_public_surface` MCP
  conclusion tool (`--preset full`, not the lean default) and the `openlore certify-public-surface` CLI
  (read-only, never blocks). Full surface count 66 → 67. Reference:
  `openspec/changes/add-public-api-surface-contract/`.

- **Symbol identity continuity — memory survives renames & moves** (FEATURE-UPDATES proposal 1) — a
  renamed or moved symbol no longer orphans the memories and decisions anchored to it. At each
  `openlore analyze`, OpenLore snapshots the prior graph, detects symbols that disappeared (anchored,
  now-unresolved) and appeared (new), and **carries the anchors forward** to the new symbol with
  `carriedAcross: { from, reason, basis, atCommit }` provenance — turning a silent `orphaned` into a
  `fresh`/`drifted (carried)` recall that `recall` surfaces with the provenance. Matching is deliberately
  conservative and threshold-free: `exact-body` (byte-identical span — a pure move) or `exact-signature`
  (the body is identical *modulo the symbol's own name* — a rename, verified by substituting the new name
  back to the old and checking the recorded baseline hash), admitted only on a strict one-to-one match
  and only when the name-independent body is unique among new symbols. A genuinely deleted symbol is
  **never** re-anchored onto an unrelated newcomer that merely shares a parameter shape; an ambiguous move
  stays orphaned and discloses `possiblyMovedTo: [...]` candidates instead of guessing. Test symbols are
  never carry targets. The anchor's `contentHash` baseline is preserved, so the existing freshness engine
  remains the single source of truth. No graph-schema change, no new MCP tool, no LLM, no clock; new
  anchor fields are additive (legacy stores load without migration). Trigger is full `analyze` (the
  incremental-watcher path is a deferred follow-up). Reference:
  `openspec/changes/add-symbol-identity-continuity/`.

- **Call resolution recall — re-export / barrel resolution** (FEATURE-UPDATES proposal 4) — the import
  resolver now follows re-export chains (`export { x } from`, `export * from`, and the TS ESM
  `.js`-specifier forms) through any depth of barrel to a symbol's **true definition**, and that
  re-export-aware map is **threaded into call-edge resolution** (Pass 2), which production builds never
  did before — so a cross-file call resolves to its real target at `import` confidence (or the new
  `re_export` confidence when a barrel hop was followed) instead of falling through to the ambiguous
  first-same-named-candidate (`name_only`). Cycle-detected and depth-bounded; gated to `imports`-capable
  languages; fail-soft. Strictly additive: when no re-export applies the result is identical to the direct
  target, and directly-resolved edges (`same_file`/`self_cls`/`type_inference`) are never dropped or
  downgraded. **Dogfood on this repo:** ambiguous `name_only` call edges fell 1067 → 87 (−92%), precise
  cross-file edges rose 0 → 1326 `import` + 21 `re_export`, unresolved `external` fell 8742 → 8563, and
  **29 symbols moved off the false-dead / false-entry-point list** (e.g. `EdgeStore.open`, reported as
  having zero callers, recovered its real 22) — raising the soundness floor under every reachability
  conclusion (`find_dead_code`, `select_tests`, `analyze_impact`, `blast_radius`,
  `report_coverage_gaps`) at once. The resolved map is also threaded into the **incremental watcher**
  (new `collectReExportBarrels` pulls barrel files into the subset for export-indexing only), so an
  incremental rebuild converges to `analyze --force` on barrel edges instead of degrading them to
  `name_only` (parity oracle Scenario 4). **Python relative imports now resolve too:** the leading-dot
  module form (`from .impl import x`, `from ..pkg.mod import y`) is resolved to the true file, and
  function-level (deferred / cycle-breaking) imports are captured — dogfooding a real Python repo this
  took precise cross-file `import` edges from 0 → 102 and cut ambiguous `name_only` from 156 → 58,
  making the registry's Python `imports` capability functional. A structural audit during
  implementation found the proposal's other edge classes — interface→implementation, override, and
  single-implementor dispatch (items 2/3) — **already delivered** by the shipped CHA pass
  (`add-type-hierarchy-resolved-dispatch`); they are cross-referenced, not re-implemented. No graph-schema
  change, no new MCP tool, no LLM. Reference: `openspec/changes/add-call-resolution-recall/`.

- **Structural test-coverage gaps + `report_coverage_gaps`** (FEATURE-UPDATES proposal 5) — a
  deterministic, graph-derived report of important code with **no reaching test**, ranked by
  `hub`/`chokepoint` significance. It is the structural **inverse** of `select_tests`: seed on every
  test node plus the production side of every `tested_by` association, forward-reach to the
  test-reachable set, and report the internal code outside it (test/generated/vendored/`.d.ts`
  excluded). No test run, no coverage instrumentation, no runtime, no LLM — the graph already encodes
  the answer. **Gaps-only and honest:** it reports "no reaching test" and never claims a symbol is
  "tested" (reachable-from-a-test is not behavior-verified); a gap with no caller at all is labeled
  *also-dead* (distinct from `find_dead_code`), an untested entry point is *untested-not-dead*, a scope
  that resolves to nothing is disclosed (never a reassuring "0 gaps"), scoped counts range over the
  in-scope set, and a stale/degraded index is surfaced in the human view (a degraded index manufactures
  false gaps). Ranking uses labels + raw evidence — no composite score, no tuning constant. Scope to a
  diff (`changedSymbols`/`diffRef`) or a region (`filePattern`); `directResolvedOnly` for a stricter
  (more gaps, more certain) report whose also-dead labeling shares the gap basis. Two surfaces: the
  opt-in `report_coverage_gaps` MCP conclusion tool (`--preset full`, not the lean default) and the
  `openlore coverage-gaps` CLI (read-only, never blocks). Distinct from `get_test_coverage` (spec-tag
  based). Full surface count 65 → 66. Reference: `docs/coverage-gaps.md`.

- **Declarative language-support registry + `get_language_support`** — the per-language knowledge
  OpenLore already encodes (call-graph extractor, CFG `SPECS` table, signature extractor, type-inference
  engine, IaC projector) is now consolidated behind one declarative capability registry
  (`src/core/analyzer/language-support.ts`), and per-language coverage is observable. Capabilities:
  `signatures`, `callGraph`, `imports`, `cfgOverlay`, `typeInference`, `styleFingerprint`,
  `iacProjection`. The registry is **derived** from the live extractor structures (not hand-listed), so
  the coverage matrix cannot silently over-claim — a behavioral test cross-checks every cell against the
  real extractor (every member of every capability set, including each `IAC_LANGUAGES` ecosystem run
  through the real analyze pipeline, plus an exact predicate assertion for `cfgOverlay`/`iacProjection`). Two
  surfaces: a **Language coverage** matrix in `.openlore/analysis/CODEBASE.md`, and the opt-in
  `get_language_support` MCP conclusion tool (repo-detected languages, or a named language as a pure
  registry lookup — fail-soft for unknown languages). Makes a quiet structural result interpretable
  ("calls unsupported for L" vs. "no callers"). No extraction-output change, no new dependency, no LLM.
  Full surface count 64 → 65. Canonical reference + "add a language" checklist: `docs/language-support.md`.

- **`map_in_flight_conflicts` — cross-actor interference map** (PARALLEL-WORK proposal 4). The team
  version of `plan_parallel_work`: instead of a caller-supplied task list it harvests every change in
  flight — local branches (git), open PRs (`gh`), and any supplied agent task descriptors — as
  actor-attributed nodes and runs the shared hazard classifier across all of them. Each footprint is
  derived from the change's ACTUAL diff: hunks map to the enclosing symbols of a re-parsed base
  snapshot, and the per-symbol `writeMode` is read off the hunks (`append` iff pure-insertion, else
  `modify`), so two PRs appending disjoint entries to the same dispatcher resolve to `shared-append`,
  not a false WAW — with no `writeMode` declaration. A change whose diff can't be fetched or whose
  symbols don't resolve is labeled "not assessed", never a false "no conflict". Read-only and stateless
  (no watcher/poll/persisted store); opt-in `federation` matches in-flight changes across repository
  boundaries by content-addressed stable id. Advisory; WAW pairs emit the policy-governable
  `cross-actor-conflict` finding a CI check can gate on. In the opt-in `coordination` and `federation`
  presets (not the lean default). Full surface count 63 → 64.

- **Index integrity attestation** — `analyze` now writes `.openlore/analysis/index-attestation.json`
  (schema version, committed production counts, content digest) deterministically. On load the
  persisted graph index is reconciled against it into a `healthy | degraded | mismatched` verdict:
  a schema-version drift is `mismatched`; a store materially smaller than the build committed (after a
  WAL checkpoint-and-recount retry, with a small-repo exemption) is `degraded`. A non-healthy index is
  never silently served — it emits a recoverable signal, surfaces on `get_health_map` as
  `indexIntegrity`, and rides the `confidenceBoundary.integrity` of `find_dead_code` / `select_tests` /
  `analyze_impact` / path tracing so a negative conclusion over a broken index is labeled
  (`complete: false`) rather than asserted. The incremental watcher keeps the attestation's counts in
  lockstep so ordinary editing never false-flags `degraded`. Advisory by default; deterministic, no LLM,
  no new MCP tool. Extends the "never present absence as current fact" store ethos to the graph index.
- **`verify_claim` `decision-current` kind** — verify a recorded decision is still
  authoritative before an agent cites it to a human ("decision X governs this, so it's
  safe"). `subject` is an 8-char decision id; the verdict is `confirmed` (recorded, not
  superseded, not rejected), `refuted` (superseded — naming the live superseder to cite
  instead — or rejected), or `unverifiable` (unknown/malformed id). It reads the same
  decision-store retirement graph the `stale-decision-reference` finding walks, so the
  active (`verify_claim`) and passive (`recall` / `openlore enforce`) surfaces can never
  disagree, and it does not touch the structural call-graph verifier. No new MCP tool
  (stays in the opt-in `verify` preset); deterministic, no LLM. Closes the deferred
  `verify_claim` clause of the finding-enforcement-policy change.

- **Unified finding-enforcement policy** — a single `enforcement.policy` block in
  `.openlore/config.json` maps a stable governance finding `code` to one enforcement
  class (`blocking | advisory | off`), decoupling a finding's intrinsic severity
  (owned by its source) from the repository's risk posture. The new `openlore enforce`
  gate collects findings from every in-scope source, resolves each through the single
  policy, and in `--hook` mode blocks the commit only on a `blocking`-classed finding
  (advisory by default; `off` findings stay visible, never invisible). The legacy
  `blastRadius.block` / `impactCertificate.block` configs lower onto it (a direct
  policy entry wins). Adds the deterministic `stale-decision-reference` finding — a
  live, authoritative artifact (approved decision / non-orphaned anchored memory /
  spec requirement) that still cites a superseded decision — also surfaced as a
  `staleDecisionRef` signal on the `recall` MCP tool's output. No new MCP tool;
  deterministic, no LLM. Flags: `--hook`, `--install-hook`, `--uninstall-hook`,
  `--json`, `--base`.
- **`openlore review` — deterministic structural PR review (#188).** A new no-LLM CLI
  command that composes the structural delta (`structural_diff`: removed/added/
  signature-changed symbols + the callers they leave stale) and the blast radius
  (`computeBlastRadius`: hubs, layers, tests to run, and the spec/memory/decision drift
  the change introduces) for a `base..head` range into one conclusion-shaped Markdown or
  JSON briefing. No new MCP tool, no new structural computation. Ships with a bundled
  GitHub Action (`.github/actions/openlore-review`) that posts it as a single sticky PR
  comment — created once, updated in place by a hidden marker, never duplicated — plus a
  copy-paste workflow. Advisory by default (exit 0); opt-in gating via the existing
  `blastRadius.block` convention. Degrades honestly (no index → structural delta only +
  "run `openlore analyze`"; non-git / unreachable base / unwritable `--out` disclosed,
  never a crash). The Action activates once a published `openlore` ships `review`.
- **OpenSpec plugin manifest (marketplace Phase 1)** — OpenLore is the inaugural
  OpenSpec marketplace plugin. It now ships a declarative plugin manifest (the
  `"openspec"` key in `package.json`, vendored schema
  `schemas/openspec-plugin-manifest-v1.json`) that OpenSpec reads to discover,
  surface, gate, and invoke OpenLore as a subprocess without importing its code.
  New `openlore plugin-manifest emit|validate` inspects/validates it — named
  distinctly from the federation `openlore manifest` so the two never collide. The
  host loader and curated registry are built separately in the OpenSpec repo.
- **Task-scoped context injection** — `openlore install` now wires a Claude Code
  `UserPromptSubmit` hook running `openlore orient --inject`, which orients on your
  submitted prompt and injects a bounded, deterministic, ignorable orientation
  block *before the agent's first turn* — amortizing the per-task `orient`
  round-trip the Value Scorecard attributes the small/familiar loss case to. A
  deterministic relevance gate keeps it out of weak/shallow tasks (degrading to a
  one-line pointer); it is fail-open (never breaks a turn) and reuses the lean
  `orient` output (no new MCP tool). Disable or tune via the `contextInjection`
  block in `.openlore/config.json` (`mode: "off"`, `tokenBudget`, gate thresholds).
  Adapters without a pre-turn hook (Cursor/Cline/Continue/AGENTS.md) fall back to
  the instruction block (#184).

### Changed

- **CLI front door now describes the product and steers to one-command setup.**
  Bare `openlore` / `openlore --help` previously opened with the legacy spec-gen
  framing ("Reverse-engineer OpenSpec specifications…") and a Quick start that sent
  new users to `openlore generate` (LLM/API-key-gated). The program description now
  reads "Persistent architectural memory for coding agents" (served via `orient` +
  MCP), the `--help` epilog leads with "Get started (one command): `openlore install`"
  and groups commands into no-API-key **Core** vs optional **Spec authoring**, the
  stale `test` line now reads "Report spec test coverage" (it never generated tests),
  and `openlore doctor` recommends `openlore install` when config/analysis is missing.
  `openlore install` and `openlore doctor` are documented in the CLI reference (#188).

- **The default MCP tool surface is now lean (behavior change).** A bare
  `openlore mcp` and a plain `openlore install` now wire the 10-tool `navigation`
  preset — the Spec 14 benchmark-winning graph-traversal core — instead of all 62
  tools. Schemas for tools the agent never calls are pure per-request overhead, so
  breadth is now opt-in. The full 62-tool surface is one explicit selector away:
  `openlore mcp --preset full` / `--all-tools`, or `openlore install --preset full`.
  No tool was removed; every capability stays reachable via its named preset
  (`minimal`, `memory`, `verify`, `federation`, `full`). When the lean default is
  active, the server advertises the opt-in once through the MCP `initialize`
  `instructions` channel (zero extra tool schemas). `openlore serve` now also
  accepts `full` as an alias of `all`, and `openlore install` / `connect` accept
  `--all-tools` (#185).

  **Migration — repos that gate commits.** The lean default does **not** include the
  governance tools the decisions pre-commit gate uses (`record_decision`,
  `check_spec_drift`, `detect_changes`). If you rely on that workflow, re-install
  with `openlore install --preset full` (all 62) or `--preset minimal` (the
  governance core) to wire them back.
- **Config-key ownership** — when OpenSpec owns `openspec/config.yaml`, OpenLore now
  writes only its `openlore` key and preserves every other key and comment
  byte-for-byte (a top-level-block string splice that keeps CRLF line endings,
  inline-comment spacing, and folded scalars intact); it refuses to overwrite a
  malformed host config rather than risk clobbering it.

### Fixed

- **`--json` / large CLI output is no longer truncated when piped.** `process.stdout` is asynchronous on
  a pipe (the normal case when an agent or shell captures `openlore … --json`), so a command that wrote a
  large payload and then `process.exit()`ed lost everything past the ~64KB pipe buffer — e.g.
  `openlore review --format json` on a real repo emitted a 100KB briefing that arrived truncated to
  exactly 65536 bytes and failed to parse (it was fine when redirected to a file, where writes are
  synchronous — so the bug only bit the pipe path agents actually use). A new `writeStdout` helper
  (`src/cli/output.ts`) resolves only after the write has flushed; the JSON-emitting CLIs (`review`,
  `coverage-gaps`, `blast-radius`, `impact-certificate`, `working-set`, `spec-store`, `audit`, `enforce`)
  await it before exiting. Found by the full-product dogfood/`--json` purity sweep.

- **HTML inline-script extraction is now truly linear on unterminated `<script>` tags.** A file full of
  unterminated `<script` open tags drove `extractHtmlScripts` into O(N²) — each open tag re-scanned to
  EOF for a close tag that never came — so a large/generated HTML file could stall `analyze` (measured
  ~24s on 100k tags; the existing "no quadratic scan" guard was too small to catch it and intermittently
  flaked CI instead). Once the close-tag search returns "none from here to EOF", no later open tag can
  have one either, so the scan now stops — restoring O(N) (100k tags: ~24s → ~17ms). Found by the
  full-product dogfood/CI pass.

- **Provenance `gh` enrichment can no longer hang or flake CI.** `enrichWithGh` short-circuits to
  the empty map when the path is not a git repository (a non-git dir can have no GitHub remote, so
  there is nothing to enrich), and bounds the `gh pr list` subprocess with a hard 10s timeout. This
  honors the documented "best-effort, never required" contract — a stalled or absent `gh` degrades
  gracefully instead of blocking analyze — and removes a flaky 5s test timeout in CI where the
  graceful-degradation test occasionally spawned a slow `gh` in a remote-less temp dir.

- **Incremental watch now converges with `analyze --force` (substrate correctness).**
  With `--watch-auto`, each save re-resolves the changed file's reverse-dependency
  closure — its direct callers (no longer capped at 10) plus prior non-callers whose
  previously-unresolved calls a newly-added symbol now binds — so the affected call
  graph matches a full re-analyze instead of silently diverging (it was depth-1 only:
  `A→B→C`, edit `C`, callers past the first 10 and newly-resolvable non-callers stayed
  stale until the next `analyze --force`). A bounded per-save work budget
  (`INCREMENTAL_CLOSURE_BUDGET`, default 40) keeps a hub edit light; over-budget or
  unreadable files are marked **explicitly stale** in the graph metadata (freshness
  verdicts over their symbols report non-authoritative, never silently wrong) and
  self-heal as later edits touch them. A full `openlore analyze --force` clears the
  region. Name resolution for duplicate simple names is now deterministic
  (seed-order-independent), so incremental and from-scratch builds agree. The
  call-graph store gains an additive `edges(callee_name)` index (keeps the new
  closure lookups sub-millisecond instead of full table scans) and a
  `busy_timeout` (a watcher save and a concurrent `analyze --force` no longer
  throw `database is locked`). A stale-region freshness downgrade is now labeled
  distinctly (`staleRegion`) and the drift detector no longer reports it as a
  code change — the anchored code is byte-identical and it self-heals.
- **Node-version guard** — launching the CLI under an unsupported Node (<22.5) now
  fails fast with one legible stderr line and the stable exit code 78 (never a
  stack trace), protecting subprocess delegation from a host on Node 20/21. The
  guard runs from a bootstrap module so it evaluates before commander loads.
- **`--json` stream purity** — `verify --json` (and, defensively, `drift`/`decisions`
  `--json`) now keep stdout pure: machine output on stdout, all logs on stderr.
- **`openlore install --no-analyze` next-step** — it skips `init` as well as
  `analyze`, so the old advice "Run `openlore analyze`" failed with "Run `openlore
  init` first." It now advises `openlore init && openlore analyze` (or `openlore
  install` to do it in one step) (#188).
- **No-key error surfaces the `claude-code` provider** — `generate` / `run` without an
  API key previously told the user only to set `ANTHROPIC_API_KEY`/etc., never
  mentioning that the Claude Code CLI (which `openlore doctor` detects) is a no-key
  provider. The error now points to `generation.provider: "claude-code"` (#188).

## [2.1.3] - 2026-06-22

Everything merged since v2.1.2: a batch of new agent-facing capabilities plus a
deep end-to-end hardening and dogfooding pass. The version is read from
`package.json`, so the CLI and the MCP server both report `2.1.3`.

### Added

- **Agent behavioral governance ("panic")** — opt-in, off by default (#175). A
  PreToolUse destabilization guard (`openlore panic-check`), an observe→memory
  feedback loop that feeds behavioral hotspots into `orient`, an optional Gryph
  runtime observer, and an accuracy-validation harness
  (`panic-validate` / `panic-calibrate` / `panic-replay`). Enable per project with
  `openlore setup --panic <mode>` and install the hooks with
  `openlore setup --hooks <format>` (remove them with `--hooks none`).
- **External spec-store binding** — the `spec_store_status` MCP tool (federation
  preset) reports the read-only health of a `.openlore/config.json` `specStore`
  binding and its indexed targets (#178).
- **Working-set context briefing** — the `working_set_context` MCP tool assembles
  one token-budgeted, per-target structural briefing for an active change across
  its spec-store targets (#180).
- **Change-impact certificate** — the `change_impact_certificate` MCP tool and the
  `openlore impact-certificate` CLI certify what a diff touches: the paths it
  newly opens into declared covering surfaces (differential, no LLM), blast
  radius, drifted specs, and the tests to run (#181).
- **Live dependency graph in watch mode** — `watch` now reconciles file creates &
  deletes and keeps `dependency-graph.json` import edges (including inline
  `<script>` and HTML asset edges) fresh incrementally (#173).
- **Pi extension** — marketplace gallery preview image (#174); Windows daemon
  hardening so no console window flashes (#177).

### Changed

- Removed the `get_decisions` MCP tool. ADRs are now surfaced through
  `search_specs` (domain `decisions`) and via `orient`'s ADR matches, which now
  work without an embedding server (#179).
- `.mjs` / `.cjs` / `.mts` / `.cts` files are now recognized as JavaScript /
  TypeScript and included in the call graph and signature index (previously
  silently dropped).
- Panic-state: the on-disk file is the single source of truth for the
  cross-process intervention counter; all writers (MCP server, hook, daemon)
  serialize through one lock.
- Documentation: Windows setup steps in CONTRIBUTING (#176); corrected and guarded
  MCP tool-count references.

### Fixed

End-to-end hardening pass (PR #182), all with regression tests:

- **First run** — `openlore init` and `openlore run` now create `.gitignore` on a
  fresh `git init` repo, so `.openlore/` analysis artifacts (multi-MB lance
  binaries) aren't accidentally committed and don't pollute diff-based tools.
- **MCP no-throw / robustness** — `get_spec` confines its `domain` argument
  (path-traversal fix); `get_file_dependencies` guards a partial dependency-graph
  artifact; `change_impact_certificate` drops non-object surface members and
  `buildLeaseAnchors` never escapes the handler; a malformed `callGraph` is
  normalized instead of crashing graph handlers; large tool results stay valid
  JSON when capped to the byte budget.
- **LLM generation** — all providers tolerate malformed or `usage`-less responses
  (common with OpenAI-compatible gateways) instead of crashing or reporting `$NaN`
  cost.
- **Panic** — fixed a cross-process lost-update on the intervention counter;
  untrusted `panic-state.json` fields are sanitized and a NaN timestamp is treated
  as expired; panic hooks gained an uninstall path and update in place on a format
  change.
- **Multi-repo federation** — a registered repo that throws mid-query is skipped
  with a reason instead of aborting the whole fleet query; tool output no longer
  leaks absolute host paths.
- **CLI** — `verify --json` and `decisions --sync` now exit non-zero on failure
  (they previously reported failure but exited 0, defeating CI gates); `decisions`
  has a top-level error boundary; `openlore view` reports a friendly message on a
  port-in-use, sanitizes errors before logging, and serves a 404 (not 500) for a
  missing graph artifact.

**Full Changelog**: https://github.com/clay-good/OpenLore/compare/v2.1.2...v2.1.3
