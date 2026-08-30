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
| 1 | Incremental updates converge or flag | **Understated.** The bullet says "a full `analyze --force` clears the region"; a budget-exceeded region has self-healed since `fix-transitive-incremental-staleness` (`mcp-watcher.ts:645-651` schedules a debounced background rebuild — though only when a host wired it, i.e. under `mcp`/`serve`, `:816`; spec `StaleRegionsAreReconciledWithoutAManualFullAnalyze` guarantees only the opportunistic path). Residue: the budget is spent in **arrival order**, so which files stay stale is arbitrary | proposal #6 |
| 2 | Index is integrity-checked, never served half-built | **Accurate; no residual gap.** Attestation, reconcile-to-healthy/degraded/mismatched, at-most-once background repair, non-destructive read (schema mismatch → not-ready, corrupt → quarantine) are all shipped and specced | no proposal |
| 3 | "Static analysis only — dynamic dispatch, runtime metaprogramming, and `eval` are not captured" | **Materially overstated.** Polymorphic dispatch is captured by CHA (`cha.ts`), and event channels, route→handler, and callback registration by the synthesis pass (`call-graph.ts:2819+`) — all provenance-labeled. The **true** residue is named in a code comment nobody can query (`reachability.ts:14-30`): reflection, computed dispatch, DI/plugin registries, cross-language bridges. #1+#2 cover the single-language part; **cross-language bridges and CHA's name+arity over-approximation stay uncovered** | proposals #1, #2 |
| 4 | LLM spec quality varies | **Accurate about accuracy; the "only automated check" framing is too broad.** Structure, import/export coverage, and drift ARE checked deterministically. What no deterministic check covers is whether a requirement's *claims* are true: the reported verdict is ~85% LLM-judged (`verification-engine.ts:874-892`). And requirements DO carry an anchor — `mapping.json` + the `> Implementation:` line — but it is built by name similarity and never resolved against the graph | proposal #3 |
| 5 | Keyword (BM25) default, semantic opt-in | **Accurate as a positioning statement; the underlying weakness is narrower than first written.** `tokenize` (`vector-index.ts:184-202`) DOES split camelCase, so `chargeCard` already matches "charge card"; what is missing is stemming and expansion, so genuinely abbreviated code (`PmtSvc` → `pmt`, `svc`) is unreachable. That is the exact query shape `orient(task)` receives on every prompt | proposal #4 |
| 6 | Large monorepos take minutes | **Accurate.** In-flight work makes the *pipeline* cheaper (parallel pool + hash-keyed Pass-1 shipped; single-pass, early-cutoff, partial-serving proposed). Untouched: there is **no concept of a package** anywhere in the analyzer, and the fact cache is explicitly machine-local (`pass1-fact-cache.ts:39`) | proposal #5 |

## The six proposals

| # | Change | Limitation | One line |
|---|--------|-----------|----------|
| 1 | `disclose-dynamic-boundary-regions` | #3 | Record reflective / computed / `eval` / DI constructs as **dynamic-boundary sites** over the already-parsed tree; conclusions disclose the sites in the subgraph they traversed via the existing confidence-boundary contract, and negative verdicts are qualified — without double-downgrading what the shipped dynamic-language cap already covers. Disclosure only — never resolution |
| 2 | `resolve-literal-reflective-dispatch` | #3 | Recover the **structurally-resolvable** half — dispatch tables, container registration, literal member on a typed receiver — with a strict-uniqueness resolver. By-name reflection (`getattr("m")`, `send(:m)`) is re-scoped OUT on measurement. Partitions with #1 by resolution outcome, enforced by test |
| 3 | `ground-generated-specs-in-the-graph` | #4 | Makes the **existing** requirement→symbol anchor graph-checked (multi-symbol, moved below the normative text, parser fixed); a deterministic checker — no LLM, no key — assigns 7 verdicts that keep `ungrounded` for positive absence only. LLM-judged scores lose their authority |
| 4 | `widen-keyword-recall-with-repo-vocabulary` | #5 | Mine an abbreviation + co-occurrence lexicon **from the repository itself** (AMAP/Lawrie-Binkley style), expand queries at search time only, **two-tier ranked** (never weighted) and bounded. Keyword mode reaches `PmtSvc` from an attested long form — no model, no download, no key |
| 5 | `scale-analyze-to-workspace-shards` | #6 | Detect package boundaries from manifests; `analyze --shard` recomputes one shard plus a **three-class resolution frontier**, with equivalence asserted over the whole graph and converge-or-flag at shard granularity. Portable fact-cache transport is deferred to its own trust-focused change. Reduces N, where the in-flight work reduces cost-per-N |
| 6 | `prioritize-incremental-closure-budget` | #1 | Spend the closure budget in **significance order within each phase** (resident fan-in/fan-out, no new metric, no new query), guard against starving test callers, and make the stale region report its structural composition instead of a file count |

## Adversarial review (2026-07-25)

Seven reviewers re-checked every proposal against the code. They found real defects in all six,
and every accepted amendment below was independently re-verified before it was applied:

| Defect | Where it would have bitten |
|---|---|
| The handler resolver returns a same-file match **regardless of repo-wide ambiguity** (`call-graph.ts:4589-4591`), and 606/3,073 internal symbols share an ambiguous simple name (`run`×15, `main`×11) | #2 would have emitted false edges, or recovered almost nothing. **Re-scoped** |
| The partition was syntactic (literal vs. not) but the refusal is semantic (resolves vs. not), so a literal naming an external target yielded **neither edge nor site** | #1+#2's honesty guarantee. **Partition is now by resolution outcome, finalized after Pass 2d** |
| `container-resolution` keyed on a bare callee name matches **666 non-test `.get(` sites in this repo** | #1 would have downgraded nearly every dead-code candidate. **Now requires a DI binding + a density budget** |
| The shard frontier missed the added-symbol rebind and the ambiguity-flip classes, and the equivalence claim was scoped to the frontier itself — **vacuously satisfiable** | #5's central soundness claim. **Three frontier classes; equivalence asserted over the whole graph** |
| A weight multiplier **cannot** guarantee "exact beats expansion" (BM25 sums unbounded), and RRF discards magnitudes entirely (`vector-index.ts:1009-1018`) | #4's ranking invariant was unimplementable. **Replaced with two-tier ordering** |
| `openlore status` **does not exist on `main`** — PR #224 never landed | #1 and #6 both named it as a delivery surface. **Removed from both** |
| The proposal claimed to target the published benchmark loss, which `AGENT-BENCHMARKS.md:141` attributes to a forced round-trip and calls unfixable | #4 would have shipped a savings claim the benchmark did not produce. **Claim withdrawn** |
| `mapping.json` + `> Implementation:` already anchor requirements; the premise "no anchor at all" was false | #3 would have built a second parallel anchor. **Rewritten to check the existing one** |

Also corrected in the README: the "cross-language bridges" residue that **no** proposal covers is
now called out as uncovered; "the only automated check is another LLM" was too broad; the
self-heal claim was host-conditional; and the tokenizer example was simply wrong
(`chargeCard` → `charge`, `card`, so it already matches).

## A seventh proposal is warranted (not yet written)

`disclose-resolution-caps-and-cha-coverage`: three fan-out caps drop call sites **whole and
silently** (`cha.ts:34` → `:356-362`; `call-graph.ts:2830` → `:3016-3023`; plus the one #2 adds),
with no receipt anywhere. And `extractJavaGraph`/`extractDartGraph` never set `calleeObject`, so
Java and Dart get override edges but effectively **no virtual-dispatch edges** — with no capability
column to say so. This is the load-bearing caveat behind the README's newly strengthened
"polymorphic dispatch **is** recovered by CHA" claim, and it falls outside #1 by construction
(#1's vocabulary is keyed on construct kind; a capped polymorphic call site is not a reflective
construct).

## Build order

| Wave | Change | Why |
|---|---|---|
| 0 | in-flight `optimize-*`, `refine-search-serving-quality`, `harden-bundle-import-trust` | #5 declares three of them; #4 collides with the fourth on `semantic.ts:538-559`; #5's cache half **depends on** the fifth |
| 1 | **#1 + #2 together** | Bidirectionally coupled — #2's refusals need #1's site recorder, #1's partition needs #2's retraction. Effectively one build, two reviews |
| 2 | **#6**, then **#4** (parallel) | #6 must precede #5 so the shared stale-composition module exists before #5 adds a second stale-region producer |
| 3 | **#5** | Blocked by wave 0, by #6, and by #1/#4 (it must know every repo-wide sidecar before it can state a retain/recompute policy) |
| any | **#3** | Fully orthogonal — shares no file with the other five |

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
