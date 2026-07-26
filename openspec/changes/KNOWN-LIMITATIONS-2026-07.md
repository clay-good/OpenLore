# Change set: known-limitations closure 2026-07 — validate what the README admits, then close it

This directory gained 6 change proposals on 2026-07-25. Each of the README's six **Known
Limitations** was first *validated against the code* (not taken at its word), then diffed against
the existing 126-proposal backlog so every proposal here is net-new whitespace rather than a
restatement of work already queued.

Two of the six limitations turned out to be **inaccurate as written** — one materially
overstated, one understated — and the README is corrected in the same PR. The other four are
real; five proposals close their residue, and one limitation (index integrity) needed no new work
at all.

## Validation results

| # | README limitation | Verdict | Evidence |
|---|---|---|---|
| 1 | Incremental updates converge or flag | **Understated.** The bullet says "a full `analyze --force` clears the region"; a budget-exceeded region has self-healed since `fix-transitive-incremental-staleness` (`mcp-watcher.ts:645-651` schedules a debounced background rebuild; spec `StaleRegionsAreReconciledWithoutAManualFullAnalyze`). Residue: the budget is spent in **arrival order**, so which files stay stale is arbitrary | proposal #6 |
| 2 | Index is integrity-checked, never served half-built | **Accurate; no residual gap.** Attestation, reconcile-to-healthy/degraded/mismatched, at-most-once background repair, non-destructive read (schema mismatch → not-ready, corrupt → quarantine) are all shipped and specced | no proposal |
| 3 | "Static analysis only — dynamic dispatch, runtime metaprogramming, and `eval` are not captured" | **Materially overstated.** Polymorphic dispatch is captured by CHA (`cha.ts`), and event channels, route→handler, and callback registration by the synthesis pass (`call-graph.ts:2819+`) — all provenance-labeled. The **true** residue is named in a code comment nobody can query (`reachability.ts:14-30`): reflection, computed dispatch, DI/plugin registries, cross-language bridges | proposals #1, #2 |
| 4 | LLM spec quality varies | **Accurate, and worse than stated.** The only check on a generated spec is *another LLM* — `specAccuracyScore` / `requirementCoverageScore` from a judge prompt (`verification-engine.ts:46`, `:528-533`) — an LLM in the guardrail path, which the north star forbids everywhere else. Requirements carry no anchor at all (`parseSpecRequirements:797-813`), the one knowledge surface in the product that doesn't | proposal #3 |
| 5 | Keyword (BM25) default, semantic opt-in | **Accurate as a positioning statement; the underlying weakness is narrower and fixable.** `tokenize` (`vector-index.ts:184-202`) is purely lexical — no stemming, no expansion, no synonymy — so a natural-language task query misses abbreviated identifiers. That is the exact query shape `orient(task)` receives on every prompt | proposal #4 |
| 6 | Large monorepos take minutes | **Accurate.** In-flight work makes the *pipeline* cheaper (parallel pool + hash-keyed Pass-1 shipped; single-pass, early-cutoff, partial-serving proposed). Untouched: there is **no concept of a package** anywhere in the analyzer, and the fact cache is explicitly machine-local (`pass1-fact-cache.ts:39`) | proposal #5 |

## The six proposals

| # | Change | Limitation | One line |
|---|--------|-----------|----------|
| 1 | `disclose-dynamic-boundary-regions` | #3 | Record reflective / computed / `eval` / DI constructs as **dynamic-boundary sites** during the Pass-1 walk; conclusions disclose the sites inside the subgraph they traversed, and `dead` / `safe-to-change` verdicts are capped at `unverifiable` next to one. Disclosure only — never resolution |
| 2 | `resolve-literal-reflective-dispatch` | #3 | Recover the **decidable** half: `getattr(o,"m")()`, `send(:m)`, `call_user_func('f')`, literal dispatch tables, literal-token DI. Reuses the event rule's static-literal reading, resolver, fan-out cap, and `synthesized` provenance — no new algorithm. Partitions with #1 by test |
| 3 | `ground-generated-specs-in-the-graph` | #4 | Generated requirements **cite the symbols they describe**; a deterministic checker over the graph — no LLM, no key — assigns `grounded` / `partially-grounded` / `ungrounded` / `uncited`. LLM-judged scores keep their provenance and lose their authority |
| 4 | `widen-keyword-recall-with-repo-vocabulary` | #5 | Mine an abbreviation + co-occurrence lexicon **from the repository itself** (AMAP/Lawrie-Binkley style), expand queries at search time only, down-weighted and bounded. Keyword mode reaches `PmtSvc.chargeCard` from "payment method" — no model, no download, no key |
| 5 | `scale-analyze-to-workspace-shards` | #6 | Detect package boundaries from manifests; `analyze --shard` recomputes one shard plus its cross-shard **edge frontier**, converge-or-flag at shard granularity; portable content-addressed fact cache for CI and teammates. Reduces N, where the in-flight work reduces cost-per-N |
| 6 | `prioritize-incremental-closure-budget` | #1 | Spend the closure budget in **significance order** (existing hub/chokepoint classifiers, no new metric), and make the stale region report its structural composition instead of a file count |

## Discipline applied

- **Every proposal was diffed against the backlog.** Nearest neighbors checked and confirmed
  distinct: `add-lsp-evidence-tier` and `shrink-receiver-resolution-boundary` (evidence tier /
  receiver typing, not dynamic disclosure), `add-callgraph-soundness-calibration` (measures the
  ladder, doesn't extend it), `add-framework-entry-point-adapters` (config wiring, not runtime
  dispatch), `harden-spec-verification-honesty` / `harden-llm-output-contract` (pipeline fidelity,
  not grounding), `refine-search-serving-quality` / `fix-bm25-identifier-tokenization` (serving
  and tokenization, not vocabulary), and the four `optimize-*` scale proposals (cost per file,
  not the file set).
- **Nothing here weakens an honesty contract.** Two proposals *add* disclosure (#1, #6), one
  replaces an LLM judge with a deterministic checker (#3), one enforces by test that recall gains
  cannot silently erase a disclosure (#2 ↔ #1 partition), and one carries the shipped
  converge-or-flag obligation into a new granularity (#5).
- **No new tuning constants, no new scores.** #2, #4, and #6 explicitly reuse existing
  constants, classifiers, and confidence tiers.
- **Every proposal is additive-by-default and reversible**: disabled or unconfigured, each
  reproduces today's output byte-identically, and each says so as a test obligation.

## Sources consulted

- Call Graph Soundness in Android Static Analysis — https://arxiv.org/abs/2407.07804
- On the Recall of Static Call Graph Construction in Practice (ICSE'20) — https://dl.acm.org/doi/10.1145/3377811.3380441
- Understanding and Analyzing Java Reflection — https://arxiv.org/pdf/1706.04567
- Citation Discipline in Spec-Driven Development — https://arxiv.org/pdf/2606.30689
- TVR: Requirement Traceability Validation and Recovery — https://arxiv.org/pdf/2504.15427
- Expanding Identifiers to Normalize Source Code Vocabulary (Lawrie & Binkley, ICSM'11) — http://www.cs.loyola.edu/~binkley/papers/icsm-11-normalization.pdf
- AMAP: Automatically Mining Abbreviation Expansions in Programs — https://dl.acm.org/doi/pdf/10.1145/1370750.1370771
- Monorepo build-tool comparison (package graph · content-addressed cache · affected-only rebuild) — https://monorepo.tools/compare
