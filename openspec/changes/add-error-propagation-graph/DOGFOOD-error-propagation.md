# DOGFOOD — `analyze_error_propagation` / `openlore error-propagation`

> Date: 2026-06-26 · branch `feat/error-propagation-graph`. Built + `npm run build` clean +
> `vitest run src examples` green (273 files, 5348 tests). Dogfooded on (a) the OpenLore repo itself
> (7583-function fresh index) and (b) a controlled TS+Python corpus.

## What was exercised

The full conclusion surface — direct escape, propagated escape (multi-hop, with call path), caught-
within (`handledInternally`), and every honesty boundary — across both TypeScript and Python, plus
catch-all (TS) and typed (Python) catch semantics.

## A. On the OpenLore repo (real code)

### `normalizeApiBase` — direct throws + external-callee disclosure
```
🔥 Error propagation
   query: normalizeApiBase::src/core/services/llm-service.ts (TypeScript)
   2 escaping exceptions (direct 2, propagated 0, dynamic 0) · 0 handled internally · 1 functions analyzed
     Error  normalizeApiBase::src/core/services/llm-service.ts:366  (thrown here)
     Error  normalizeApiBase::src/core/services/llm-service.ts:371  (thrown here)
   · 1 external/unresolved callee(s) not analyzed (...)
```
**Verified against source:** line 366's `throw new Error(...)` lives in the *catch* body of the
`try { new URL(url) }` at 363-366 — correctly reported as **escaping** (a throw in a catch body is not
guarded by that try), distinct from a throw in the try body. Line 371 is unguarded. `parsed.toString()`
is honestly disclosed as an external callee, not assumed exception-free.

### `handleFindClones` — multi-hop propagation + caught-within, on a 100-function subtree
```
   4 escaping exceptions (direct 0, propagated 4, dynamic 0) · 4 handled internally · 100 functions analyzed
     Error  validateDirectoryDepth::.../utils.ts:103  (via validateDirectory → validateDirectoryImpl → validateDirectoryDepth)
     Error  validateDirectoryImpl::.../utils.ts:68   (via validateDirectory → validateDirectoryImpl)
     ...
   handled internally (callers shielded):
     Error  caught in load::.../utils.ts:317  (from open::.../edge-store.ts)
     <dynamic> caught in load::.../utils.ts:317  (from dbPath::.../edge-store.ts)
   · 88 external/unresolved callee(s) not analyzed (...)
```
The conclusion an agent actually wants: *calling `handleFindClones` can throw `Error` from directory
validation (here are the exact call paths), while the DB-open errors are already caught internally in
`load`.* The 88 stdlib-leaf callees are collapsed into one counted disclosure rather than 88 lines.

### Honesty paths (all explicit, none silent)
- `--symbol main` → ambiguity: lists the 8 `name::path` candidates.
- `--symbol thisDoesNotExistXYZ` → explicit not-found.
- `--symbol main::.../pulumi/main.go` (Go) → explicit `unsupported`: *"not supported for Go … NOT a
  claim that the function throws nothing."*

## B. Controlled TS+Python corpus (`init` → `analyze` → query)

| Query | Result | Confirms |
|-------|--------|----------|
| TS `top` | 1 propagated `TypeError` via `middle → lowest` | multi-hop propagation + call path |
| TS `guarded` | 0 escapes, 1 handled (`TypeError` caught at `guarded:11`) | TS catch-all swallows → caller shielded |
| PY `load` | 1 propagated `ValueError` from `parse` | Python `raise ValueError()` extracted + propagated |
| PY `safe_load` | 0 escapes, 1 handled (`ValueError` caught at `safe_load:11`) | **Python typed `except ValueError` matches the propagated type** |

The `safe_load` case is the key cross-language proof: a typed `except ValueError:` correctly catches a
`ValueError` propagated up from a callee, while the same handler would *not* swallow a differently-named
exception (conservative, disclosed).

## C. Language registry

`languageSupport('TypeScript'|'JavaScript'|'Python').capabilities` includes `errorPropagation`;
`'Go'` does not — the registry derives the cell from the extractor's own `ERROR_PROPAGATION_LANGUAGES`
set, so `get_language_support` cannot over-claim.

## Issues found + fixed during dogfooding

1. **Boundary noise.** The first run emitted one boundary line per external callee (88 lines for
   `handleFindClones`), burying the substantive disclosures. **Fix:** collapse external/unresolved
   callees into a single counted summary (`externalCalleesNotAnalyzed: { count, sample }`) while
   keeping structural boundaries (depth bound, unsupported-language callee, Python typed-except,
   source-unreadable) as full messages.

## Determinism

Two identical runs of `--symbol caller` (and `handleFindClones`) produce byte-identical JSON
(asserted in the handler unit test; confirmed by hand on the repo).

## D. Adversarial review round (post-merge hardening)

Three independent adversarial reviewers stress-tested the extractor and the propagation handler.
They found real soundness bugs — all in the dangerous "over-claim handled / stale result" direction —
which were fixed and pinned with regression tests:

1. **CRITICAL — `locallyHandled` resolved by line, not byte/AST containment.** A `throw` in an outer
   catch body that shared a physical line with an inner one-line swallowing try was falsely marked
   *handled* (claimed contained when it escapes). **Fix:** containment is now byte-precise
   (`TryGuard.fromIndex/toIndex`, `ThrowSite.index`); a throw/call is "inside" a `try` only if its
   node lies within the body's byte span. Verified e2e:
   `wrapAndGiveUp` → `GiveUp` correctly **escapes** (previously: wrongly handled).
2. **Nested-guard under-resolution (extractor + handler).** Only the single *innermost* guard was
   checked, so a throw inside an inner typed `except KeyError` wrapped by an outer `except Exception`
   was wrongly reported escaping. **Fix:** resolution walks **all** enclosing guards
   (`enclosingGuards` / `guardsCatch`) — an inner non-matching guard no longer shadows an outer
   catch-all. Verified e2e: Python `caller` → `ValueError` is **handled** by the outer catch-all.
3. **HIGH — memo poisoning under truncation.** `escapes(n)` cached results even when a child hit the
   depth/parse bound, so a later shallow path reused a stale incomplete answer (dropped a real
   escape). **Fix:** only fully-computed (untruncated) results are memoized; a truncated subtree is
   recomputed on a shallower path. Regression test: `q→a→b→c→d` (deep, truncated at `maxDepth=3`) +
   `q→c` (shallow) — `TypeError` still surfaces via the shallow path.

Also fixed: wrapped throws `throw (new E())` / `throw new E() as Error` now resolve to `E` (were
`<dynamic>`); a `handledInternally` sort tiebreak on `fromCallee`/line; **test-only callees are
excluded** from the production escape set with disclosure (caught live: `handleFindClones` dropped 10
spurious test-edge paths, `functionsAnalyzed` 100 → 47, cleaner production-only result).

Post-fix: extractor 21 tests, handler 13 tests, registry 35 tests — all green; full suite green.

## E. Second adversarial round (e2e dogfooding, real `init`→`analyze`→query)

Three more independent adversarial agents ran ~73 crafted e2e scenarios end-to-end against the **built
CLI** (fresh `init` → `analyze --no-embed` → `error-propagation --json`), each writing the runtime
ground truth *before* running and flagging only the dangerous directions (over-claim handled / dropped
escape / crash / wrong type):

- **TypeScript/JavaScript exception semantics — 24 scenarios.** try/finally-no-catch, conditional
  rethrow, throw in a nested closure, throw in a catch body, async/await, one-line same-line
  swallow-vs-throw, 3-level nesting, ternary throw, class methods, `.js` parity. **0 unsound** in the
  exception logic itself.
- **Python exception semantics — 27 scenarios.** typed/tuple/`as`/bare `except`, `except Exception`,
  re-raise non-swallow, subclass-not-modeled (conservative escape + disclosed), `raise … from`,
  multi-hop shielding, `try/else` (raise in `else` correctly escapes), qualified raise/except. **0
  unsound.**
- **Cross-function traversal/handler — 22 scenarios.** mutual/self recursion (terminates), diamond
  dedup, call-site-specific catch (same callee guarded at one site, unguarded at another → escapes),
  depth-bound disclosure, memo-not-poisoned-by-truncation (both edge orders), test-callee exclusion,
  external-callee disclosure, `--max-depth` clamping. **0 unsound, 0 hang/crash.**

**One real soundness gap found and fixed (this round):** a method calling a sibling via
`this.method()` produced **no call-graph edge at all** — neither a resolved method edge nor an
`external::` edge — so a throw reachable only through `this.method()` was silently reported as
`escapes: 0, boundaries: []` (reads as a proof of exception-freedom). Confirmed at the source of
truth (the `caller→callee` edge is absent from `call-graph.db` while the typed-param control
`o.callee()` resolves). **Fix:** the extractor now classifies each call site's receiver
(`self` / `other` / `none`); the handler joins the query's own `this.`/`super.`/`self.`/`cls.` call
sites against the resolved edges and discloses any with no edge in a new `unresolvedSelfCalls` count +
sample and a boundary — never assuming them exception-free. Precisely targeted: Python `self.method()`
*does* resolve in the call graph, so it is correctly **not** flagged (no false positives); only the
genuinely-unresolved TS/JS `this.method()` is disclosed. Verified e2e: `caller` (`this.callee()` that
throws) now reports `unresolvedSelfCalls: 1` with the boundary; the resolving control reports `0`.
Regression tests: extractor receiver classification (TS + Python), handler disclosure + no-false-
positive (review S2).

## F. Upstream fix: the `this.method()` gap closed at the source (call graph)

The §E disclosure was the honest stopgap; the root cause was an upstream call-graph hole — `this.`/
`super.` receiver calls were never captured as edges (the TS call query only matched an `(identifier)`
receiver). That hole was blinding **every** edge-traversing tool, not just this one. It is now fixed
in the call graph (change `add-this-super-method-resolution`, same PR): `this.m()` resolves to the
enclosing class (then `extends` ancestors), `super.m()` to the parent, with file/import affinity to
avoid false cross-file edges, a receiver-aware noise filter (so `this.parse()`/`this.map()` are not
dropped), and unresolved this/super calls dropped rather than turned into junk `external::` leaves.

Two adversarial agents drove the fix: one hunted false edges (found + fixed cross-file same-named-class
mis-binding and cross-file parent decoys via file affinity), one confirmed the cross-tool benefit
(`analyze_impact` fan-in, `find_dead_code` false-dead removed, `find_path`, JS parity, Python
no-regression) and found the noise-filter swallow (`this.parse()` dropped before resolution — fixed).

Composed result, dogfooded on the OpenLore repo: every `Logger.*` → `this.log()` edge now resolves
(`self_cls`); `analyze_error_propagation` on `handleBatch` went from `escapes 2 / handled 2 /
functionsAnalyzed 449 / unresolvedSelfCalls 39` to `escapes 3 / handled 32 / functionsAnalyzed 580 /
unresolvedSelfCalls 2` — the resolution traces what it can, and the §E disclosure honestly flags the
small residue (unindexed-parent edge cases). The disclosure and the resolution compose: resolved calls
are analyzed, the genuinely-unresolvable ones are still never assumed exception-free.

A third adversarial round (three agents) stress-tested the composed system: the error-prop × this/super
interaction (18 scenarios — recursion/mutual-recursion terminate, depth bounds disclosed, super
propagation correct, 0 unsound/hang); an exotic-syntax fuzz (30 scenarios) that found a FALSE-edge
class — an object-literal method shorthand / nested function inside a class method inherited the class
name and so produced a false `self_cls` edge — now FIXED by stopping the className walk at an
object/function boundary (removed 18 false edges on the real repo, self_cls 433→415, every genuine
edge preserved); and a real-repo correctness audit (26 sampled self_cls edges all correct, 0 false, 0
cross-file). Full suite green (273 files / 5370 tests).
