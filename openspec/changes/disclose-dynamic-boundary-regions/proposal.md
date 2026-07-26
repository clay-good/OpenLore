# Dynamic-boundary regions: the call graph names where it stops seeing, instead of returning a quiet lower bound

> Status: PROPOSED (2026-07-25, known-limitations closure #1 of 6). The README says
> "dynamic dispatch, runtime metaprogramming, and `eval`-based patterns are not captured
> in the call graph." Two of those three are now partly captured (CHA virtual dispatch,
> event/route/callback synthesis) — but the residue is *invisible*: a file that dispatches
> through `getattr`, `send`, `obj[name]()`, a DI container, or `eval` produces a graph that
> looks exactly like a file with no calls at all. This change makes the residue a
> first-class, queryable artifact: **dynamic-boundary sites**, extracted during the existing
> Pass-1 walk, attached to the enclosing symbol, and disclosed by the conclusion tools whose
> soundness depends on completeness. No resolution, no guessing — disclosure only. Its
> sibling `resolve-literal-reflective-dispatch` recovers the statically-decidable subset;
> this change owns everything that stays unrecoverable.

## The gap

- **The blind spots are already known — and already written down in a code comment, not in
  the graph.** `src/core/services/mcp-handlers/reachability.ts:14-30` names them precisely:
  "reflection, computed/string-built dispatch (`obj[name]()`), cross-language bridges and
  cross-language polymorphism, DI/plugin registries with no statically-visible binding,
  RTA/VTA-level pruning of the CHA name+arity over-approximation, and externally-consumed
  public exports — these can still produce false 'dead' positives." That paragraph is a
  static caveat on every answer. It cannot say *which* answer is affected, because nothing
  records *where* the boundary was crossed.
- **Reflective constructs are actively swallowed, not recorded.** Python's `getattr` /
  `setattr` / `hasattr` sit in `PYTHON_IGNORED` (`src/core/analyzer/call-graph-builtins.ts:23`)
  and are dropped before edge resolution; `importlib`, `inspect`, and Go's `reflect` are in the
  external-module set (`src/core/analyzer/call-graph-external.ts:32`, `:39`) and resolve to an
  `external::` edge that says nothing about the dispatch it performs. Ruby `send` /
  `public_send` / `method_missing` / `define_method`, JS `eval` / `new Function` / `Proxy` /
  `Reflect.get`, and PHP `call_user_func` / `$$var()` have no handling at all. In every case
  the *evidence that a dynamic dispatch happened here* is discarded at extraction time, so it
  can never be recovered downstream.
- **The consequence is a confident-looking silence — the exact failure mode the product
  exists to prevent.** `find_dead_code` reports a plugin invoked only through a registry as a
  dead candidate; `report_coverage_gaps` labels it `also-dead`; `analyze_impact` under-reports
  the blast radius of a symbol reached only reflectively; `analyze_error_propagation` treats a
  reflectively-invoked callee as exception-free. Each is a *sound lower bound* by doctrine, but
  the human reading the answer is given no signal that this particular answer sits next to a
  hole. OpenLore's own thesis — "an agent's expensive failure mode isn't ignorance, it's
  confidence" — applies to OpenLore's own output here.
- **The measured scale of the problem is not small.** "Call Graph Soundness in Android Static
  Analysis" (arXiv 2407.07804) found 13 mature static-analysis tools missed, on average, **61%
  of dynamically-executed methods**; the ICSE'20 recall study
  (https://dl.acm.org/doi/10.1145/3377811.3380441) reaches the same conclusion for Java. The
  literature's settled position — the "soundiness" manifesto — is that a real analysis is
  unsound *by design* and its obligation is to **state its unsound features explicitly**. That
  obligation is precisely what OpenLore's honesty contract already claims, and precisely what
  the graph currently cannot honor per-answer.

## What changes

**1. A dynamic-dispatch site becomes an extracted fact.** During the Pass-1 tree walk (the same
walk that already tallies the style fingerprint with an explicit "no second parse" discipline),
a small per-language matcher records each construct that performs dispatch the resolver cannot
follow. Each site is `{ filePath, line, enclosingSymbolId, kind, evidence }` where `kind` comes
from a **closed, source-declared vocabulary** — no free-text, so it is queryable and testable:

| `kind` | Constructs (initial set) |
|---|---|
| `reflective-invoke` | Python `getattr(o, x)()`, `operator.methodcaller`; Ruby `send` / `public_send` / `method(...)`; PHP `call_user_func(_array)`, `$$fn()`; Java/C# `Method.invoke` / `MethodInfo.Invoke`; Go `reflect.Value.Call` |
| `computed-member` | `obj[expr]()` where `expr` is not a static literal (JS/TS, Python subscript-call, Ruby `[]`) |
| `code-eval` | `eval`, `new Function`, Python `exec`/`eval`/`compile`, Ruby `instance_eval`/`class_eval`, PHP `eval` |
| `dynamic-import` | `importlib.import_module(expr)`, `__import__`, `require(expr)`, `import(expr)` with a non-literal specifier |
| `metaprogrammed-definition` | Ruby `define_method` / `method_missing`, Python `setattr` on a class / metaclass `__getattr__`, JS `Proxy` / `Reflect.defineProperty` |
| `container-resolution` | DI resolution by token: `container.get/resolve/make(...)`, Spring `getBean`, `@Inject`-style construction with no statically-visible binding |

A construct whose argument **is** a static literal is NOT a boundary — it is the sibling
change's business (`resolve-literal-reflective-dispatch`), which resolves it into a real edge.
Only the undecidable residue is recorded here. The two changes share one matcher and partition
its output; neither can double-count.

**2. The sites are persisted and roll up to a region view.** Sites are stored alongside the
existing per-file analysis artifacts (no schema change to `nodes`/`edges`: a sidecar keyed by
file, mirroring how `parse-health.json` already discloses per-file parse boundaries). A symbol
is `dynamicBoundaryAdjacent` when it *contains* a site; a region (community) carries a count.
Aggregate counts land in the `parse-health`-adjacent disclosure surface and in `openlore status`.

**3. The conclusion tools disclose the boundary they are standing next to — per answer, not
per README.** Every tool whose soundness rests on reachability completeness gains a
`dynamicBoundaries` entry in its existing `boundaries` / disclosure field, naming the file,
line, and `kind` of the sites *inside the subgraph it just traversed* (bounded, deduped by
kind+file, with a truncation receipt):

- `find_dead_code` — a candidate whose file or whose callers' files contain a
  `container-resolution` / `reflective-invoke` site is **downgraded in confidence** and carries
  the site as its reason. It never becomes "not dead" (that would be a guess), but it stops
  being presented at the same confidence as a symbol with no dynamic neighborhood.
- `report_coverage_gaps` — the `also-dead` label is withheld (falling back to the plain gap
  label) when the symbol sits behind a dynamic boundary, since `also-dead` asserts the absence
  of any caller.
- `analyze_impact`, `blast_radius`, `select_tests`, `analyze_error_propagation`,
  `change_impact_certificate` — the traversal already returns a lower bound; it now names the
  sites that make it one, in the same disclosure shape each tool already uses.
- `verify_claim` — a `dead` or `safe-to-change` verdict over a subject with a dynamic boundary
  in its neighborhood is capped at `unverifiable` rather than `confirmed`. This is the single
  highest-value consumer: it is the tool an agent calls *immediately before asserting to a
  human*, and it is exactly where a quiet lower bound becomes a confident false statement.

**4. A registered governance finding, advisory by default.** A new
`dynamic-boundary-in-conclusion-scope` code in `FINDING_CODE_REGISTRY`
(`src/core/services/mcp-handlers/enforcement-policy.ts`) with source-declared severity `info`,
so a team that wants CI to notice "this deletion candidate sits behind a DI container" can
class it `blocking` — and everyone else sees nothing change.

**Explicitly NOT built:** any attempt to *resolve* these sites (points-to analysis, string
solving, dynamic tracing, an LLM guess at intent). The whole value here is that the boundary is
reported as a boundary. Runtime observation stays out of scope (frozen in
`defer-gryph-runtime-observability`); LSP-tier evidence is a separate opt-in
(`add-lsp-evidence-tier`).

## Why this is in scope

The north star is a *deterministic structural context substrate* whose distinguishing property
is that it tells an agent when a fact is not to be trusted. Today the graph has one whole class
of unknowns it detects at parse time and then throws away, leaving conclusion tools to caveat in
prose what they could have disclosed in data. This is the same move the project already made
twice and shipped — `parse-health` (per-file parse boundaries) and the epistemic lease (context
staleness) — applied to the last large undisclosed unknown. It adds no capability, no
dependency, and no hot-path cost; it converts a README paragraph into a per-answer receipt.

## Impact

- **Files:** a new `dynamic-boundary.ts` matcher (per-language node-type + callee-name tables,
  invoked from the existing Pass-1 walk in `call-graph-extract.ts` / `call-graph.ts`), a
  sidecar artifact writer next to `parse-health`, `mcp-handlers/reachability.ts` (confidence
  downgrade + reason), `mcp-handlers/coverage-gaps.ts` (`also-dead` withholding),
  `mcp-handlers/claim-verification.ts` (verdict cap), the shared boundary-disclosure helper used
  by impact/blast-radius/error-propagation, `enforcement-policy.ts` (one finding code),
  `openlore status`, `docs/reachability-dead-code.md`, `docs/language-support.md`.
- **Specs:** `analyzer` — 2 ADDED (DynamicBoundarySitesAreExtractedAndPersisted,
  DynamicBoundaryVocabularyIsClosedAndPartitioned); `mcp-handlers` — 2 ADDED
  (ConclusionsDiscloseDynamicBoundariesInScope, DeadAndSafeVerdictsAreCappedNearADynamicBoundary).
- **Tool surface:** unchanged — no new tool, no preset change. Existing responses gain a
  bounded `dynamicBoundaries` array inside the disclosure field they already carry.
- **Performance:** one node-type check per call/subscript node on the existing walk; no second
  parse, no new artifact read on the serving path (the sidecar is loaded with the graph).
- **Risk:** (a) *matcher noise* — a language whose idiom uses `send`/`get` innocuously inflates
  the site count; mitigated by a closed, per-language vocabulary with a false-negative bias (an
  unrecognized construct is simply not recorded, exactly as today) and by the fact that a site
  never changes an edge, only a disclosure. (b) *disclosure fatigue* — every answer in a
  reflective codebase carrying a boundary list; mitigated by scoping sites to the traversed
  subgraph, deduping by kind+file, and bounding with a truncation receipt. (c) *scope creep
  toward resolution* — mitigated by the spec's explicit "records, never resolves" clause, with
  resolution owned by the named sibling change.
