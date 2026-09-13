# Change status

Which proposals are built and which are not — decided by evidence, not by each proposal's own
status line. Two signals, both cheap to re-check:

- **built** — the change's name appears in a `change: <name>` marker in `src/`, and/or every
  requirement its delta adds is already in `openspec/specs/<domain>/spec.md` (verify against the
  code before trusting a marker-less "shipped" claim)
- **archivable** — `openspec archive <name>` completes

## State as of 2026-07-27 (spec-backlog repair pass)

The corpus is fully green: **all 15 main specs and all 94 open changes pass `openspec
validate`**, and the archive machinery works again. This pass:

- **Repaired the main specs** that had blocked archiving since the corpus first drifted:
  39 decision-synced requirements fixed across `cli` (22), `mcp-handlers` (15+Purpose),
  `config` (1), `overview` (1) — missing scenarios backfilled, 11 cross-domain stubs rewritten
  as normative deferrals with pointer scenarios, 3 double-"The system SHALL" glitches fixed,
  and the missing `## Purpose` added to `mcp-handlers`. The decision-sync template recurrence
  fix shipped and was archived as `2026-08-01-fix-decision-sync-template-validity`.
- **Archived 28 changes** (as `2026-07-27-*`): the 12 formerly "built, blocked on bookkeeping",
  all 10 formerly "claims built" (each verified against the code first — all 10 were real),
  `fix-analyze-native-abort-and-file-cost-budget` (PR #294), and the 3 `defer-*` scope-decision
  records (archived `--skip-specs` as resolved doc-only changes; their won't-do rationale
  remains readable in `archive/`).
- Two archives needed delta refreshes first: `make-index-self-healing` (its MODIFIED target
  `ReadyOrHonestFirstUse` was never in the corpus — converted to a self-contained ADD) and
  `unify-navigation-and-governance-substrate` (its MODIFIED block predated the ADR-0023
  substrate-default flip — refreshed to shipped reality). Two were archived `--skip-specs`
  because their requirements were already synced verbatim (`fix-pi-parity-drift`,
  `fix-redaction-module-gaps`).

## Complete — 150 in `archive/`

Everything in `openspec/changes/archive/` is shipped (or a settled won't-do), with its
requirements reflected in the main specs. `openspec list` shows only open work.

## In flight — 0

(`shrink-receiver-resolution-boundary` merged in #465 and awaits archiving.)

A change belongs here the moment its implementation starts; move it back out (archive it) the
moment its marker/spec evidence lands.

## To build — 99

The whole open set is unbuilt backlog. Newest additions: 7 proposals from the 2026-07-27
first-run e2e (`E2E-FIRSTRUN-2026-07-27.md`). Other thematic indexes:
`E2E-AUDIT-2026-07.md`, `KNOWN-LIMITATIONS-2026-07.md`,
`COMPETITIVE-SUBSTRATE-2026-07.md`.

Shipped since compile: `harden-walker-corpus-boundary` (2026-08-02, archived) — the walker
truncation receipt, includePatterns-override-directory-pruning, and nested-`.gitignore` semantics;
`harden-api-decision-and-generate-safety` (2026-08-08, archived) — decision-sync transition
enforcement, scoped TLS configuration, verification-evidence disclosure, and consolidation logs;
`fix-first-analysis-self-contamination` (2026-08-08, archived) — installer-owned artifacts no
longer skew domains, languages, or high-value files, and undomained source files are disclosed;
`fix-inject-relevance-gate-keyword-mode` (2026-08-08, archived) — exact identifier and scale-free
rank evidence make task-scoped injection reachable in the zero-config keyword mode;
`fix-empty-orient-and-corpus-honesty` (2026-08-09, archived) — empty orientations explain their
misses with bounded near-token receipts, and synthetic external nodes no longer enter the
searchable function corpus; `widen-import-resolution` (2026-08-09, archived) — Go, Java, Kotlin,
C#, and PHP now resolve statically unique package/import bindings at `import` confidence;
`add-secret-redaction-boundary` (2026-08-09, archived) — source-carrying tool results and both
sides of persisted LLM logs share deterministic, disclosed credential redaction;
`disclose-stale-serving-on-cold-reads` (2026-08-09, archived) — cold navigation reads disclose
changed cited files and active watcher/serve hosts schedule repository-scoped repair;
`align-first-run-ctas-with-repo-shape` (2026-08-09, archived) — install gates the prove CTA on
the built graph, sparse refusals carry receipts, fresh empty spec stores are informational, and
uninstall names retained data; `fix-mcp-argument-contract` (2026-08-15, archived) — omitted tool
directories resolve to the validated server launch root, explicit roots still win, and strict
advertised schemas reject unknown arguments before any watcher, rebuild, telemetry, or write;
`harden-llm-request-lifecycle` (2026-08-15, archived) — timeouts abort provider fetches and
streams, provider ceilings are constants-backed, correction requests retain their contract,
truncation is disclosed once, and fallback model ids are pricing-consistent;
`harden-review-render-and-action` (2026-08-15, archived) — PR-head text is inert in Markdown,
analysis freshness and failures are disclosed, and the bundled Action documents and enforces its
write-token trust boundary without suppressing configured policy gates;
`harden-llm-output-contract` (2026-08-16, archived) — malformed structured entries no longer
discard valid siblings, truncation and provider errors fail explicitly, and every LLM-derived
verification metric and mixed composite carries its evidence and model provenance;
`fix-commit-gate-delivery` (2026-08-16, archived) — every Git-hook installer targets Git's
effective hook path, manager-owned hooks fail honestly, doctor checks reachability, concurrent
edits are atomic, and machine JSON envelopes carry an explicit schema version.
`add-change-evidence-audit` (2026-08-16, archived) — `openlore change-status` now computes the
marker/spec-sync evidence pass with receipts, delegates typed non-interactive validation to the
OpenSpec CLI, and emits human, JSON, or pasteable table output without mutating lifecycle state.
`add-agent-loop-enforcement-hook` (2026-08-30, archived) — explicit blocking policy findings can
stop an agent turn with remediation-first feedback, while frozen findings and infrastructure
failures remain advisory; Claude Code wiring is opt-in and idempotent.

After this table was compiled, four research sweeps added 32 more proposals (all validate; not yet
folded into the table): 10 in `FIELD-RESEARCH-2026-07.md`, 10 in `ECOSYSTEM-RESEARCH-2026-07-27.md`,
5 in `SUBSTRATE-WHITESPACE-2026-07-27.md`, and 7 in `GOVERNANCE-SUBSTRATE-2026-07-31.md` — see those
indexes for the per-change one-liners.

The 2026-07-31 governance-substrate sweep is the first one aimed at the governance face rather than
the navigation face: corpus integrity, corpus-delta intent review, decision-bound constraints with
an enforcement-eligibility ledger, retrieval hit/miss evidence, derived-artifact equivalence
certification with a published scale envelope, measured standing surface cost, and a named
trust boundary for served content.

| Change | What it is |
|---|---|
| `add-assumption-anchored-resolutions` | a governed way to answer a disclosed boundary |
| `add-benchmark-harness-protocol` | A checked-in benchmark protocol for default-surface decisions |
| `add-build-graph-ingest` | declared monorepo target structure as provenance-tagged evidence |
| `add-callgraph-soundness-calibration` | measure the honesty claims instead of asserting them |
| `add-codeowners-ownership-evidence` | ownership-aware conclusions, no new tool |
| `add-complexity-trend-signal` | Complexity trend over git history — a rising/flat/falling label on the churn+complexity OpenLore already mines |
| `add-conclusion-followup-hints` | a conclusion that warrants a next check says so, with a receipt |
| `add-coverage-map-test-selection` | an opt-in precision layer over static reachability |
| `add-dependency-impact-analysis` | consumer-side blast radius for a dependency bump |
| `add-deprecation-propagation` | extract the deprecated bit in the existing walk, surface it as a finding |
| `add-edit-loop-breakage-verdict` | The graph learns about a breaking edit in milliseconds; the agent learns at commit time |
| `add-enforcement-baseline-ratchet` | a `frozen` class that blocks only NEW findings |
| `add-flag-impact-analysis` | Piranha's deterministic kernel, no rewriter |
| `add-incremental-bundle-delta` | apply a stale ancestor bundle, then re-analyze only the delta |
| `add-incremental-early-cutoff` | unchanged extracted facts stop the invalidation cascade |
| `add-knowledge-map-and-coupling-upgrades` | bus factor, temporal aggregation, ticket-ID grouping |
| `add-lsp-evidence-tier` | compiler-grade receipts for existing verdicts, never a navigation surface |
| `add-memory-anchor-verdicts` | memories about one line stop drifting with the whole function |
| `add-memory-trigger-predicates` | the right memory pushes itself into the briefing, deterministically |
| `add-merge-tree-conflict-oracle` | A `git merge-tree` textual-conflict oracle inside map_in_flight_conflicts — separate "git will auto-merge" from "git will conflict" |
| `add-ownership-tagged-conclusions` | per-conclusion staleness instead of a blanket lease |
| `add-perf-regression-counter-budgets` | A deterministic counter-based performance budget in CI — catch the "fourth parse pass" before it lands |
| `add-scip-index-interchange` | overlay compiler-verified resolution onto the tree-sitter ladder |
| `add-sfc-script-extraction` | disclose, then index, the code inside .vue/.svelte/.astro |
| `add-span-precise-conclusions` | Conclusions drop the line numbers the substrate already stores |
| `add-structural-search-tool` | deterministic AST pattern search as a conclusion tool |
| `add-symbol-content-hashes` | exact symbol-level changed-sets between revisions |
| `add-symbol-provenance-conclusions` | when did this exist, what changed it last, what moves with it |
| `add-vuln-reachability-triage` | is the vulnerable function actually reachable from my code? |
| `adopt-agent-context-interop` | AGENTS.md first-class, the orient skill portable, the injected digest evidence-slim |
| `adopt-mcp-tasks-and-cache-hints` | cache hints carry the lease, tasks carry long builds |
| `adopt-spec-link-status-vocabulary` | name "Unwanted", "Predated", and shallow-vs-deep coverage, from OpenFastTrace |
| `align-api-layer-with-cli-core` | The programmatic API is a fork of the CLI pipeline, not a facade over it — realign and make its contract embedder-safe |
| `disclose-dynamic-boundary-regions` | the call graph names where it stops seeing, instead of returning a quiet lower bound |
| `enforce-preset-membership-at-dispatch` | the advertised surface must be the callable surface |
| `fix-complexity-language-parity` | Go/Ruby/Rust/Swift/Elixir report ~1 regardless of shape |
| `fix-config-validation-completeness` | Config validation must catch what actually breaks the run, and `doctor` must not bless a config that does |
| `fix-drift-reporting-honesty` | silent truncation, hook failures reported as drift, and invisible memory-staleness kinds |
| `fix-empty-orient-and-corpus-honesty` | a zero-match briefing explains itself, and the corpus contains only real symbols |
| `fix-git-derived-signal-honesty` | prior churn measured before the change, no stale capability claims, work-tree-aware repo detection |
| `fix-interference-map-honesty` | no silently dropped branches, no fake WAR from shared reads |
| `fix-mcp-argument-contract` | a sensible directory default, actionable missing-arg errors, no silently ignored arguments |
| `fix-overlay-language-fidelity` | Ruby CFG, destructured params, env-var semantics, Go arity |
| `fix-process-exit-lifecycle` | no zombie MCP servers, no post-failure hangs |
| `fix-test-detection-language-parity` | every callGraph-backed language deserves a working `isTestFile` |
| `fix-test-selection-soundness` | identity-keyed seed coverage, disclosed depth cap, disclosed substring widening |
| `fix-windows-invocation-surface` | spawns that ENOENT, configs that can't launch, and no support statement |
| `ground-generated-specs-in-the-graph` | resolve requirement→symbol citations against the graph |
| `harden-analyze-rebuild-atomicity` | The full edge-store rebuild is not atomic — concurrent readers see empty/partial/doubled graphs, and a >5s lock silently drops watcher work |
| `harden-bundle-import-trust` | integrity is not authenticity, and "verified current" must be earned |
| `harden-chat-agent-surface` | per-provider model resolution and honest terminal states |
| `harden-daemon-lifecycle` | protect the token, win the start race, drain before exit, bound the caches |
| `harden-grammar-load-disclosure` | A missing core-language grammar silently zeroes the whole language — disclose it, and stop the capability matrix over-claiming |
| `harden-llm-log-and-telemetry-honesty` | LLM logs persist full source always-on and unrotated; telemetry's kill-switch is inverted and its disclosure is narrower than what it records |
| `harden-llm-output-contract` | shape-check what you parse, disclose what you drop |
| `harden-llm-prompt-injection-boundary` | Untrusted repo content is instruction-level in every LLM prompt, and the agent-CLI providers run it tool-enabled |
| `harden-openspec-writer-fidelity` | The spec writer deletes human content on merge, discards validation results, and over-deletes domains that a filter never meant to remove |
| `harden-pi-config-and-daemon-fidelity` | The Pi extension clobbers governance config, blocks the first turn on an unbounded orient, and misdiagnoses a missing binary as "not analyzed" |
| `harden-review-render-and-action` | head-controlled text is hostile, and stale analysis must say so |
| `harden-spec-verification-honesty` | no silent decision loss, no shrinking denominator, no fabricated requirement claims |
| `harden-vector-index-coherence` | a rebuilt index must never be served through stale process caches |
| `harden-view-server-file-confinement` | The view server's file access is lexical-only — a symlink in a cloned repo escapes the project root; and it serves arbitrarily stale analysis as current |
| `optimize-incremental-and-coldstart-scale` | A branch switch grinds through the per-file incremental pipeline with no bulk fallback, reloading the full node table once per changed file |
| `optimize-serving-hot-path-caches` | The default tools rebuild derived graph structures and re-parse multi-MB artifacts on every call, and re-scan the whole corpus per keyword search |
| `promote-backed-language-visibility` | the generated matrix discloses its scope, the docs get one canonical page |
| `refine-first-run-partial-serving` | minutes of "no index found" before the first answer |
| `refine-public-surface-certification` | rule codes + semver bump, an accepted-breakage baseline, consumer-weighted verdicts |
| `resolve-literal-reflective-dispatch` | recover the *structurally* decidable subset, and refuse the rest loudly |
| `scale-analyze-to-workspace-shards` | a monorepo stops paying for the whole repo on every analyze |
| `shrink-traversal-index-invalidation-scope` | The traversal structure is invalidated by edits it does not depend on |
| `unify-onboarding-entrypoint` | install once, auto-init on every repo you touch |
| `widen-architecture-rule-vocabulary` | required, circular, reachable/orphan, captures, instability |
| `widen-overlay-language-coverage` | Go error flow, Kotlin/Dart types, four CFG languages, Python/Go HTTP clients |

Shipped and archived since: `refine-first-run-partial-serving` (2026-09-06) — an index-absent
first build now flushes a partial index and serves the repository structure and dependency graph
from it, with a completeness receipt attached at the dispatcher so every transport carries it,
negative conclusions withheld, and the published output still byte-identical to a single-write
build. Four rounds of adversarial review during the build also closed three PRE-EXISTING holes the
feature made reachable in the state where `.openlore/` is most likely to be adversarial (a freshly
cloned repo with no analysis): a named pipe under `.openlore/` could hang a tool call and stop the
server from exiting, the generation-manifest reads that verify every artifact were unbounded, and
a committed `.openlore/runtime` symlink redirected a recursive delete out of the repository.

Shipped and archived since: `disclose-dynamic-boundary-regions` (2026-09-06) — the call graph now
records every dispatch it cannot follow (reflection, computed members, `eval`, dynamic imports,
metaprogrammed definitions, DI resolution) as a **dynamic-boundary site**, and every conclusion whose
soundness rests on reachability discloses the sites inside the subgraph it traversed. `find_dead_code`
names the specific construct, `report_coverage_gaps` withholds `also-dead`, and `verify_claim` caps a
`dead`/`safe-to-change` verdict at `unverifiable` — disclosure only, never resolution, and never the
opposite conclusion. Four adversarial review rounds plus an end-to-end dogfood on three external
repositories found 19 defects during the build, the sharpest being a `moduleLevel` marker that was
false on 38% of sites and a retraction key that let an ordinary call erase a site outright.

Shipped and archived since: `resolve-literal-reflective-dispatch` (2026-09-12) — a stable
module-private JS/TS literal dispatch table (`HANDLERS[k]()`, `HANDLERS["create"]()`) now binds each
entry by its same-file declaration as a `literal-reflective` synthesized edge; every refusal stays a
disclosed dynamic-boundary site. Bound constructs are persisted separately so directly-resolved-only
conclusions still disclose them, a subset rebuild or an over-bound file binds nothing, and the watcher
re-derives rebuilt callers. Three rounds of four adversarial reviews re-scoped it twice: self-typed
receivers (`this["m"]()`, `getattr(self, "m")()`) were built and then removed because the class graph
cannot bound the receiver type soundly, and container resolution and Python dicts stay disclosed.

Shipped and archived since: `ground-generated-specs-in-the-graph` (2026-09-12, narrowed) — a pre-build
evidence audit found most of it superseded by the shipped deterministic spec link index, so it closes
the defects that remained: generated anchors are written below the normative text (the verifier no
longer describes a requirement by its anchor), requirements sharing an anchor key must agree or get
no anchor, and an anchor whose symbol is absent from a file the analysis cannot vouch for is
`not-assessed` with a named boundary (`language-not-extracted`, `file-not-analyzed`) instead of a false
`stale`, matched by the file's real spelling and re-assessed before a cached index is served. Two
review rounds withdrew `#### Requirement:` recovery (OpenSpec counts only `###`) and a parse-health
boundary (wrong extractor's evidence).

Shipped and archived since: `add-test-selection-safeguard-tiers` (2026-09-12, flakiness reader
deferred) — a diff's changed, added, and untracked test files are always selected beside the backward
walk, so a test-only diff no longer selects nothing. Every selection carries the `reason` behind its
served path and any other reasons, a path across synthesized edges carries a `structuralBasis`, and
`flakiness: { assessed: false }` is stated because no local per-test outcome history exists. Four
adversarial reviews fixed path frames for subdirectory analysis, over-broad test classification,
string-sorted depth reasons, cyclic `tested_by` paths, and an unbounded, silently failing untracked
listing (now capped at 200 with disclosure).

Shipped and archived since: `adopt-mcp-protocol-conformance` (2026-09-12, narrowed) — tool
annotations have no read-only fallback, and a TypeScript-checker trace from every dispatch branch to
write, spawn, and worker primitives fails CI when a read-only tool reaches a write outside a reasoned
allowlist. The audit corrected seven tools (two unlisted writers, `audit_spec_coverage` now dispatched
with `save: false`, destructive and open-world hints). Argument-validation failures are `isError`
results that name the parameter, the expected shape, and a schema-valid corrected call, bounded and
redacted. Output schemas (measured +19% to +96% of the substrate standing cost) and elicitation for
decision approval are deferred to their own changes.

Shipped and archived since: `add-framework-entry-point-adapters` (2026-09-12, narrowed) — deterministic
readers of the root package.json, tsconfig files, vitest/vite/jest setup files, and POSIX-shell GitHub
Actions `run:` steps make every function in a file a config executes an `externally-wired` liveness
root with a receipt, in `find_dead_code`, the shared dead set, `report_coverage_gaps`, and the
entry-point digest. A shell tokenizer counts only executed files (never arguments, redirects, or
heredoc bodies); variables, globs, `cd`, modules by name, PowerShell steps, and unreadable configs are
reasoned boundaries. Four adversarial reviews plus a fix-verification review hardened it against false
wiring, FIFO hangs, a YAML merge-key bomb, quadratic scans, and unbounded boundary growth. On this
repository 36 of 1,018 entry points are config-invoked.

Shipped and archived since: `refine-orient-context-budgeting` (2026-09-13, narrowed) — `orient`'s
`tokenBudget` fits the whole response as sent: the top-`limit` answer is built exactly as without a
budget, then functions ranked past `limit` are added with their call paths while they fit, or whole
lowest-ranked entries are trimmed peripheral-first with the fewest removals. Decisions, memories,
architecture violations, and matching specs are never dropped, and a `budget` receipt reports the exact
served size. Four adversarial reviews found the first version widened the pool before fitting (a
budget above the default returned less); two verification rounds hardened the redesign. Cold-start
expansion, seed shaping, and `get_minimal_context` are deferred.

## Maintenance rules (what kept this table honest)

- Ship a `change: <name>` marker in the code, or expect this table to call the change unbuilt.
- Never let a decision sync write a scenario-less requirement (see archived
  `2026-08-01-fix-decision-sync-template-validity`); `openspec validate --specs` must stay green.
- Archive promptly: a built change sitting open makes every count in this file wrong.
- Re-verify this file by re-running the evidence pass, not by trusting it.
