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
