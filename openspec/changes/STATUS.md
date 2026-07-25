# Change status

Which proposals are built and which are not — decided by evidence, not by each proposal's own
status line. Two signals, both cheap to re-check:

- **built** — the change's name appears in a `(change: <name>)` marker in `src/`, and/or every
  requirement its delta adds is already in `openspec/specs/<domain>/spec.md`
- **archivable** — `openspec archive <name>` completes

As of 2026-07-25, **105 changes are open**. 22 were archived in this pass — the newest being
`optimize-hash-keyed-analyze` (PR #288: Pass-1 extraction memoized by content hash).

## Not built — 80

The real backlog. No code, no spec entry.

| Change | What it is |
|---|---|
| `add-agent-loop-enforcement-hook` | Enforcement in the agent loop: a Stop-hook gate with remediation-first findings |
| `add-assumption-anchored-resolutions` | Assumption-anchored resolutions: a governed way to answer a disclosed boundary |
| `add-benchmark-harness-protocol` | A checked-in benchmark protocol for default-surface decisions |
| `add-build-graph-ingest` | Build-graph ingest: declared monorepo target structure as provenance-tagged evidence |
| `add-callgraph-soundness-calibration` | Call-graph soundness calibration: measure the honesty claims instead of asserting them |
| `add-codeowners-ownership-evidence` | CODEOWNERS as declared-ownership evidence: ownership-aware conclusions, no new tool |
| `add-complexity-trend-signal` | Complexity trend over git history — a rising/flat/falling label on the churn+complexity Open |
| `add-conclusion-followup-hints` | Data-dependent follow-up hints: a conclusion that warrants a next check says so, with a rece |
| `add-coverage-map-test-selection` | Coverage-mapped test selection: an opt-in precision layer over static reachability |
| `add-dependency-impact-analysis` | Add analyze_dependency_impact: consumer-side blast radius for a dependency bump |
| `add-deprecation-propagation` | Add deprecation propagation: extract the deprecated bit in the existing walk, surface it as  |
| `add-edit-loop-breakage-verdict` | The graph learns about a breaking edit in milliseconds; the agent learns at commit time |
| `add-enforcement-baseline-ratchet` | Enforcement baseline ratchet: a `frozen` class that blocks only NEW findings |
| `add-flag-impact-analysis` | Feature-flag impact analysis: Piranha's deterministic kernel, no rewriter |
| `add-framework-entry-point-adapters` | Framework entry-point adapters: config-wired code stops reading as orphaned |
| `add-incremental-bundle-delta` | Incremental bundle catch-up: apply a stale ancestor bundle, then re-analyze only the delta |
| `add-incremental-early-cutoff` | Incremental early cutoff: unchanged extracted facts stop the invalidation cascade |
| `add-knowledge-map-and-coupling-upgrades` | Knowledge map and coupling upgrades: bus factor, temporal aggregation, ticket-ID grouping |
| `add-lsp-evidence-tier` | LSP evidence tier: compiler-grade receipts for existing verdicts, never a navigation surface |
| `add-memory-anchor-verdicts` | Sub-symbol anchors and a named anchor-lost work item: memories about one line stop drifting  |
| `add-memory-trigger-predicates` | Memory trigger predicates: the right memory pushes itself into the briefing, deterministical |
| `add-merge-tree-conflict-oracle` | A `git merge-tree` textual-conflict oracle inside map_in_flight_conflicts — separate "git wi |
| `add-ownership-tagged-conclusions` | Ownership-tagged conclusions: per-conclusion staleness instead of a blanket lease |
| `add-perf-regression-counter-budgets` | A deterministic counter-based performance budget in CI — catch the "fourth parse pass" befor |
| `add-scip-index-interchange` | SCIP ingest: overlay compiler-verified resolution onto the tree-sitter ladder |
| `add-secret-redaction-boundary` | One redaction boundary: repo secrets never reach the model or the log undisclosed |
| `add-sfc-script-extraction` | SFC script extraction: disclose, then index, the code inside .vue/.svelte/.astro |
| `add-span-precise-conclusions` | Conclusions drop the line numbers the substrate already stores |
| `add-structural-search-tool` | Add search_structural: deterministic AST pattern search as a conclusion tool |
| `add-symbol-content-hashes` | Symbol content hashes: exact symbol-level changed-sets between revisions |
| `add-symbol-provenance-conclusions` | Symbol provenance conclusions: when did this exist, what changed it last, what moves with it |
| `add-test-selection-safeguard-tiers` | Test-selection safeguard tiers: always-select rules, flakiness disclosure, and a structural- |
| `add-vuln-reachability-triage` | Add triage_vuln_reachability: is the vulnerable function actually reachable from my code? |
| `adopt-agent-context-interop` | Adopt the agent-context interop standards: AGENTS.md first-class, the orient skill portable, |
| `adopt-mcp-protocol-conformance` | Adopt MCP protocol conformance: guarded annotations, output schemas, actionable errors, elic |
| `adopt-mcp-tasks-and-cache-hints` | Adopt the MCP 2026-07-28 RC: cache hints carry the lease, tasks carry long builds |
| `adopt-spec-link-status-vocabulary` | A richer spec↔code link-status vocabulary: name "Unwanted", "Predated", and shallow-vs-deep  |
| `align-api-layer-with-cli-core` | The programmatic API is a fork of the CLI pipeline, not a facade over it — realign and make  |
| `fix-commit-gate-delivery` | Fix commit-gate delivery: install hooks where git actually looks, and version the machine co |
| `fix-complexity-language-parity` | Fix cyclomatic-complexity language parity: Go/Ruby/Rust/Swift/Elixir report ~1 regardless of |
| `fix-drift-reporting-honesty` | Fix drift reporting honesty: silent truncation, hook failures reported as drift, and invisib |
| `fix-git-derived-signal-honesty` | Git-derived signal honesty: prior churn measured before the change, no stale capability clai |
| `fix-interference-map-honesty` | map_in_flight_conflicts honesty: no silently dropped branches, no fake WAR from shared reads |
| `fix-overlay-language-fidelity` | Fix per-language fidelity defects inside claimed (✓) overlays: Ruby CFG, destructured params |
| `fix-pi-parity-drift` | Fix MCP↔Pi parity drift: decision-current, missing conclusion tools, a two-direction guard |
| `fix-redaction-module-gaps` | Fix redaction-module gaps: Basic-auth credentials survive, cycles return the unredacted orig |
| `fix-test-detection-language-parity` | Test-file detection language parity: every callGraph-backed language deserves a working `isT |
| `fix-test-selection-soundness` | select_tests soundness receipts: identity-keyed seed coverage, disclosed depth cap, disclose |
| `fix-windows-invocation-surface` | Windows invocation surface: spawns that ENOENT, configs that can't launch, and no support st |
| `harden-analyze-rebuild-atomicity` | The full edge-store rebuild is not atomic — concurrent readers see empty/partial/doubled gra |
| `harden-api-decision-and-generate-safety` | The API's decision-sync force-approves rejected decisions, its generate disables TLS process |
| `harden-bundle-import-trust` | Harden bundle import trust: integrity is not authenticity, and "verified current" must be ea |
| `harden-chat-agent-surface` | Harden the viewer chat agent: per-provider model resolution and honest terminal states |
| `harden-daemon-lifecycle` | Harden the daemon lifecycle: protect the token, win the start race, drain before exit, bound |
| `harden-grammar-load-disclosure` | A missing core-language grammar silently zeroes the whole language — disclose it, and stop t |
| `harden-llm-log-and-telemetry-honesty` | LLM logs persist full source always-on and unrotated; telemetry's kill-switch is inverted an |
| `harden-llm-output-contract` | Harden the LLM output contract: shape-check what you parse, disclose what you drop |
| `harden-llm-prompt-injection-boundary` | Untrusted repo content is instruction-level in every LLM prompt, and the agent-CLI providers |
| `harden-llm-request-lifecycle` | Harden the LLM request lifecycle: a timeout must cancel the request, not abandon it |
| `harden-openspec-writer-fidelity` | The spec writer deletes human content on merge, discards validation results, and over-delete |
| `harden-pi-config-and-daemon-fidelity` | The Pi extension clobbers governance config, blocks the first turn on an unbounded orient, a |
| `harden-review-render-and-action` | Harden review rendering and the bundled Action: head-controlled text is hostile, and stale a |
| `harden-spec-verification-honesty` | Harden spec-verification honesty: no silent decision loss, no shrinking denominator, no fabr |
| `harden-vector-index-coherence` | Harden vector index coherence: a rebuilt index must never be served through stale process ca |
| `harden-view-server-file-confinement` | The view server's file access is lexical-only — a symlink in a cloned repo escapes the proje |
| `harden-walker-corpus-boundary` | Harden the walker corpus boundary: no silently smaller graph |
| `optimize-analyze-pipeline-passes` | One analyze makes 3-4 full passes over the corpus, re-parsing (and re-reading from disk) tre |
| `optimize-incremental-and-coldstart-scale` | A branch switch grinds through the per-file incremental pipeline with no bulk fallback, relo |
| `optimize-reachability-precompute` | Every reachability conclusion re-runs BFS over adjacency rebuilt for that call |
| `optimize-serving-hot-path-caches` | The default tools rebuild derived graph structures and re-parse multi-MB artifacts on every  |
| `promote-backed-language-visibility` | Promote backed-language visibility: the generated matrix discloses its scope, the docs get o |
| `refine-first-run-partial-serving` | The first index is all-or-nothing: minutes of "no index found" before the first answer |
| `refine-orient-context-budgeting` | Refine orient context budgeting: exact-fit payloads, cold-start breadth, seed-conditioned sh |
| `refine-public-surface-certification` | Refine public-surface certification: rule codes + semver bump, an accepted-breakage baseline |
| `refine-search-serving-quality` | Refine search serving quality: filters that filter, scores that say what they are, an index  |
| `shrink-receiver-resolution-boundary` | Shrink the intra-object receiver boundary with deterministic per-file type registries |
| `unify-onboarding-entrypoint` | One entrypoint: install once, auto-init on every repo you touch |
| `widen-architecture-rule-vocabulary` | Widen the architecture rule vocabulary: required, circular, reachable/orphan, captures, inst |
| `widen-import-resolution` | Widen import-precise cross-file resolution beyond TS/JS/Python |
| `widen-overlay-language-coverage` | Widen the per-language overlay matrix: Go error flow, Kotlin/Dart types, four CFG languages, |

## Built, blocked on bookkeeping — 12

The code shipped; only the archive step fails, for the reason given. Not a code problem.

| Change | What it is | Why it is stuck |
|---|---|---|
| `add-config-schema-validation` | Config schema validation: typo'd keys disclosed, version drift visible | `config` spec has malformed decision-synced requirements |
| `add-decision-autopilot` | Decision autopilot: auto-accept governance with a first-class audit trail | `cli`, `mcp-handlers` spec has malformed decision-synced requirements |
| `add-parse-health-boundary-disclosure` | Parse-health disclosure: no silent under-extraction from parse errors, grammar drift, or unr | its own delta file is missing a `## Purpose` header |
| `add-symbol-span-locator` | Symbol span locator: a read-only, staleness-checked edit location the host can trust | its own delta file is missing a `## Purpose` header |
| `add-zero-interaction-onboarding` | Zero-interaction onboarding and a passive update notifier | `cli` spec has malformed decision-synced requirements |
| `fix-cli-output-hygiene` | CLI output hygiene: color contract, config errors, honest summaries, one vocabulary | `cli` spec has malformed decision-synced requirements |
| `fix-default-preset-claims` | One default, said once: align every surface with the substrate default (ADR-0023) | `cli` spec has malformed decision-synced requirements |
| `fix-epistemic-lease-weights` | Complete the epistemic-lease weight table and bind it to the tool registry | its own delta file is missing a `## Purpose` header |
| `fix-structural-diff-merge-base` | structural_diff must read old content at the merge-base, not the base ref's tip | its own delta file is missing a `## Purpose` header |
| `harden-federation-freshness` | Harden federation freshness: baseline the empty fingerprint, degrade a corrupt registry | its own delta file is missing a `## Purpose` header |
| `make-index-self-healing` | Make the index self-healing: staleness triggers repair, not just disclosure | delta modifies a requirement that is no longer in the spec |
| `unify-navigation-and-governance-substrate` | Unify navigation and governance as two faces of one structural substrate | delta modifies a requirement that is no longer in the spec |

## Scope decisions — 3

Settled decisions *not* to build something, kept as the record of why.

| Change | What it is |
|---|---|
| `defer-gryph-runtime-observability` | Gryph runtime observability (deferred follow-up from PR #83) |
| `defer-panic-blocking-enforcement` | Panic blocking enforcement — `experimental_blocking` mode (deferred follow-up from PR #83) |
| `defer-panic-setup-hooks` | Panic setup hooks — `setup --hooks` / `--panic` (deferred follow-up from PR #83) |

## Claims built, no evidence found — 10

The proposal says done, but there is no `(change: …)` marker in `src/` and its requirements are
not in the spec. Probably shipped without leaving a marker — each needs one look. **Do not
archive these on the status line alone.**

| Change | What it is |
|---|---|
| `delegate-lifecycle-scope-decision-sync` | Scope the decision syncer and delegate change lifecycle to OpenSpec |
| `fix-bm25-identifier-tokenization` | Identifier-aware BM25 tokenization: `getUserById` must match a query for `user` |
| `fix-decision-status-transitions` | Guard decision status transitions: sync must never resurrect a rejected decision |
| `fix-drift-gate-blindness` | Fix drift-gate blindness: uncommitted work always counts +0/-0, and ADR updates never suppre |
| `fix-git-path-quoting` | Git path quoting: history-derived joins silently drop non-ASCII filenames |
| `fix-update-install-detection` | Fix `openlore update` install-method detection: never mutate the wrong install |
| `harden-decision-consolidation` | Harden decision consolidation: fail-closed spawns, CAS status promotion, coalesced runs |
| `harden-panic-response-runtime` | Harden the panic-response runtime: escapable blocking, atomic watcher singleton, honest gate |
| `persist-tokenized-keyword-corpus` | Persist the tokenized keyword corpus: make the tokenizer-version stamp guard a real serve-ti |
| `wire-global-config-path` | Wire the global `--config` path: an explicit config location is actually honored |
