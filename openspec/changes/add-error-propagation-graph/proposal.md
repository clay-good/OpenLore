# Error-propagation graph: what exceptions escape a function, and where are they caught

> Status: IMPLEMENTED (2026-06-26, branch `feat/error-propagation-graph`). `analyze_error_propagation`
> MCP tool + `openlore error-propagation` CLI + `exception-flow.ts` extractor + `errorPropagation`
> language capability (TS/JS/Python). `npm run build` clean; `vitest run src examples` green (273
> files / 5348 tests). Dogfooded e2e on the OpenLore repo + a TS+Python corpus (see
> `DOGFOOD-error-propagation.md`). As-built note: external/unresolved callees are collapsed into one
> counted `externalCalleesNotAnalyzed` summary (caught in dogfooding — a per-callee list buried the
> substantive disclosures); the spec's boundary requirement is unchanged.
>
> Post-merge adversarial-review hardening (same PR): containment is byte-precise (not line-based) so a
> throw in a catch body is never mis-attributed as handled; handling walks ALL enclosing guards so an
> inner typed `except` never shadows an outer catch-all; truncated (depth/cap-bounded) traversals are
> never memoized (no stale shallow reuse); wrapped throws (`throw (new E())` / `as Error`) resolve; and
> test-only callees are excluded from the production escape set (disclosed). See
> `DOGFOOD-error-propagation.md` §D.
>
> A net-new conclusion tool —
> the written backlog (`FEATURE-UPDATES.md`, `STRUCTURAL-CONTEXT-PATTERNS.md`,
> `PARALLEL-WORK-COORDINATION.md`, `HARDEN-DISTRIBUTION-AND-SUBSTRATE.md`) is fully shipped. This is
> the explicitly-earmarked follow-up from `FEATURE-UPDATES.md` ("Deliberately considered and
> deferred"): the *exception / error-propagation graph*, scoped — per that note — to a sound,
> narrow subset of the CFG-overlay languages rather than a broad, unsound version. No new dependency,
> no LLM, no new persisted artifact, no schema migration.

## Why

OpenLore's call graph answers *who calls whom*. It is silent on a question a coding agent asks
constantly while editing: **"if I call this function, what can blow up — and is it already
handled?"** Equivalently, when an agent changes a function to throw, it needs to know **"who is
exposed, and where (if anywhere) is this already caught?"** Today the agent must read every body on
the path by hand to answer either.

The existing CFG overlay (`cfg.ts`) already models try/catch/finally/throw *structurally* — as
control-flow branches and early-exit edges — but it records **zero exception semantics**: not which
types are thrown, not which a handler catches, not whether an exception escapes a function. So the
substrate has the control-flow skeleton but not the propagation answer.

This change adds that answer as a deterministic, conclusion-shaped tool. It is the error-handling
analogue of `analyze_impact` (blast radius of a *change*) and `select_tests` (tests reaching a
change): **the exceptions reaching a function's callers, with provenance and catch-resolution.**

## What changes

1. **A deterministic per-function exception extractor** (`src/core/analyzer/exception-flow.ts`):
   given a function's source span and language, it tree-sitter-parses the body and extracts
   - **throw sites** — the constructed exception type (`throw new TypeError()` → `TypeError`;
     `raise ValueError(...)` → `ValueError`; a bare re-raise / `throw e` → `<dynamic>`), each tagged
     with whether it is caught by an enclosing handler **within the same function**;
   - **try regions** — the body span each `try` guards, whether its handler is a catch-all
     (every TS/JS `catch`; Python bare `except` / `except Exception`), the exact types a typed
     Python `except` names, and whether the handler re-throws (a re-throwing handler does not
     swallow).
   It deliberately does **not** descend into nested closures/functions (consistent with the CFG
   overlay): a throw inside a nested closure is attributed to that closure, not the enclosing
   function. This is disclosed as a boundary.

2. **A new conclusion tool `analyze_error_propagation`** (handler
   `src/core/services/mcp-handlers/error-propagation.ts`, CLI `openlore error-propagation`):
   given a `symbol`, it walks the cached call graph's callee edges (bounded depth, cycle-guarded),
   extracts each reachable function's exception facts live, and computes
   - **`escapes`** — the exception types that can propagate *out* of the query function to its
     callers: each function's own un-caught throws, plus exceptions escaping a callee whose call
     site is *not* guarded by a catching `try` in the caller. Each carries provenance (origin
     function/file/line, the call path, and whether it is a direct throw or propagated);
   - **`handledInternally`** — exceptions thrown somewhere in the reachable subtree but caught
     within the query's own body (so the *caller* is shielded), naming the catch site;
   - **`boundaries`** — the honesty disclosures (callees in unsupported languages or external/
     bodyless, dynamic re-raises whose type is unknown, Python typed-catch matched by exact name
     only, depth/size truncation).

3. **A new language-support capability `errorPropagation`** in the declarative registry
   (`language-support.ts`), derived from the extractor's own `ERROR_PROPAGATION_LANGUAGES` set so it
   cannot over-claim. Scope: **TypeScript, JavaScript, Python** — the languages with clean,
   statically-extractable throw + typed/untyped catch semantics. Every other language fail-soft
   reports the capability as unsupported (`get_language_support` stays honest), and a query whose
   symbol is in an unsupported language returns an explicit `unsupported` record, never an empty
   "throws nothing".

## What does NOT change

- **No LLM, fully deterministic.** Extraction is a tree-sitter walk; propagation is a bounded,
  memoized graph traversal. Re-running on a fixed repo state is byte-identical.
- **No new persisted artifact, no schema migration.** Computed live from the already-cached call
  graph plus a re-read of the source it spans — the `find_clones` precedent exactly. The hot
  call-graph walk and the EdgeStore schema are untouched.
- **No new tuning constant or composite score.** `escapes` / `handledInternally` are *labeled sets*,
  not a ranked salience number. `maxDepth` and the analyzed-function cap are operational bounds
  (like `find_clones`'s `maxResults`), disclosed when they truncate — not weights.
- **Conclusion over graph.** The tool returns the computed escape/handled sets with provenance,
  never a node-and-edge dump.
- **Tool-surface discipline.** `analyze_error_propagation` is classified `conclusion` and lands in
  the **full opt-in surface only** — never `MINIMAL_TOOLS`, the lean first-run default, or a curated
  preset.

## Honesty boundaries (soundness over coverage)

The tool reports a **sound lower bound** of what is statically extractable, with every gap disclosed
rather than papered over:

- A callee that cannot be analyzed (external, bodyless, unsupported language, or beyond the depth/
  size bound) is **not** assumed exception-free — it is listed as a boundary, and the exceptions it
  might raise are out of scope, not silently "none".
- A bare re-raise / re-throw of a caught variable (`raise`, `throw e`) has an unknowable static type;
  it is surfaced as `<dynamic>`, never dropped.
- Python `except` catch resolution matches by **exact type name** (plus the catch-all `except` /
  `except Exception`); subclass relationships are not modeled (no type hierarchy), so a typed
  `except Base` is conservatively treated as **not** catching a differently-named subtype — it
  propagates, and the limitation is disclosed.
- TS/JS `catch` is always a catch-all (the language has no typed catch); a re-throwing catch does not
  swallow.

These mirror the established `confidence-boundary`, authoritative-recall, and `report_coverage_gaps`
"sound direction only" invariants.

## Decision (recorded before code)

- New MCP conclusion tool `analyze_error_propagation` + `openlore error-propagation` CLI; new
  analyzer module `exception-flow.ts`; new language capability `errorPropagation` (TS/JS/Python).
- Computed live from the cached graph + a source re-read (no new persisted artifact, no schema
  change); reuse the CFG overlay's per-language throw/try node-type knowledge rather than a new
  grammar.
- Sound-lower-bound semantics with disclosed boundaries; opt-in full-surface only.

## Dependencies

- The cached call graph (callee edges with call-site lines) and the tree-sitter parsers already
  vendored for TS/JS/Python. Reuses the throw/try node-type sets encoded in `cfg.ts`.
- No dependency on any other unshipped change.

## Out of scope

- Languages whose exception model is return-value/`Result`-based (Go, Rust) or whose catch typing
  needs a class hierarchy to be sound at scale (a broad multi-language version) — explicitly deferred
  by the earmark note.
- Cross-service / cross-process exception flow (the call graph stops at the process boundary).
- Any persisted exception overlay or new EdgeStore table — deferred unless a whole-repo audit
  variant is later wanted (this is the symbol-scoped, live-computed companion, like `find_clones`
  is to `get_duplicate_report`).
