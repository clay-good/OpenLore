# Language support: the capability registry, the coverage matrix, and adding a language

OpenLore's reach is its languages. This page is the canonical reference for **what OpenLore
extracts per language**, how that is made observable, and the minimal checklist for adding or
widening a language.

## The capability set

Each language backs a fixed, closed set of capabilities. A capability is either backed by data
(supported) or absent (fail-soft) — there is no partial-credit fiction.

| Capability | Meaning | Authoritative source |
|---|---|---|
| `signatures` | A dedicated signature extractor (params/return shape) rather than the generic fallback. | `SIGNATURE_LANGUAGES` (`signature-extractor.ts`) |
| `callGraph` | Function/method node + call-edge extraction — the substrate every reachability conclusion rests on. | `CALLGRAPH_LANGUAGES` (`call-graph.ts`) |
| `imports` | Relative-import resolution into the `import`-confidence cross-file edge path. For TS/JS this follows re-export/barrel chains (`export { x } from`, `export * from`) to the true definition, labelling the recovered edge `re_export`. For Python it resolves the leading-dot module form (`from .impl import x`, `from ..pkg.mod import y`), including function-level (deferred) imports. | `IMPORT_RESOLUTION_LANGUAGES` (`import-resolver-bridge.ts`) |
| `cfgOverlay` | A control-flow-graph overlay (branches/loops) via the data-driven CFG `SPECS` table. | `cfgSupportsLanguage()` (`cfg.ts`) |
| `typeInference` | Lightweight receiver-type inference, used to resolve method calls to their class. | `TYPE_INFERENCE_LANGUAGES` (`type-inference-engine.ts`) |
| `styleFingerprint` | Descriptive per-language idiom-frequency profile (function form, binding, conditional, async, string, naming case) with an evidence floor + enforcement-awareness. Backed for TypeScript/JavaScript/Python/Go. | `STYLE_FINGERPRINT_LANGUAGES` (`style-fingerprint.ts`) |
| `iacProjection` | Infrastructure-as-code projection (resources/edges) onto the unified graph. | `isIacLanguage()` / `IAC_LANGUAGES` (`iac/types.ts`) |
| `crossServiceHttp` | Cross-service API topology: outbound HTTP client call sites (`fetch`/`axios`/`ky`/`got`) and/or server route registrations are matched into `http_endpoint` edges across the process (and, under federation, the repo) boundary, so `analyze_impact`/`find_path`/`blast_radius` answer "who calls this endpoint?". Clients: TS/JS; routes: TS/JS (Express/NestJS/Next), Python (FastAPI/Flask/Django), Java (Spring/JAX-RS). | `CROSS_SERVICE_HTTP_LANGUAGES` (`http-route-parser.ts`) |
| `errorPropagation` | Static throw/raise + typed/untyped catch extraction, so `analyze_error_propagation` can compute the exceptions that escape a function vs. those caught within it. Throw types resolved from `throw new X()` / `raise X()`; TS/JS `catch` is catch-all, Python `except` matched by exact name (no subclass hierarchy); containment is byte-precise. Backed for TypeScript/JavaScript/Python. | `ERROR_PROPAGATION_LANGUAGES` (`exception-flow.ts`) |

## The registry is derived, not hand-listed

The declarative registry (`src/core/analyzer/language-support.ts`) is the single source of truth for
"what we know about language L" — but it is **computed** from the same structures the extractors
consult at run time (the table above), never hand-maintained in parallel. So the coverage matrix
cannot silently drift from what the analyzer actually does. `language-support.test.ts` behaviorally
cross-checks **every member** of the `signatures`, `callGraph`, `imports`, `typeInference`,
`cfgOverlay`, `styleFingerprint`, `crossServiceHttp`, and `errorPropagation` sets by running the real extractor on a per-language fixture and asserting it produces
output (a malformed entry that produced nothing fails the test, not just the predicate tautology);
`cfgOverlay` and `iacProjection` are additionally asserted exactly against their predicates
(`cfgSupportsLanguage`, `isIacLanguage`) for every language, and `iacProjection`'s per-ecosystem node
tagging is covered by the dedicated `iac/*.test.ts` suite and an end-to-end analyze check.

This means an over-claimed matrix is structurally prevented — which matters, because an over-claimed
coverage matrix is worse than none.

> **JavaScript note.** JavaScript is parsed by the TypeScript extractor, so a JS-only repo may report
> its detected language as `TypeScript` in some repo-level views even though JS is a first-class
> registry key (named-mode `get_language_support` for `JavaScript` reports its real capabilities, and
> the style fingerprint slices JS and TS apart by the file's actual language).

## The fail-soft contract (uniform)

A language with **no registry record**, or a record that does **not back a capability**, yields
*nothing* for that capability — never an error, never a guess. Asking about an unsupported language is
honest: `languageSupport('Haskell')` returns `{ known: false, capabilities: [] }`; it does not throw
and does not fabricate. This is the same fail-soft behavior the CFG builder already practiced, now a
guaranteed contract for every capability.

The payoff is **interpretability**: a quiet structural result becomes readable. "No callers for `foo`
in a Kotlin file" means "no callers" only if `callGraph` is supported for Kotlin; if it is not, the
quiet means "calls are not extracted for this language," not "nothing reaches it."

## Observing coverage

Two surfaces expose the matrix:

- **The analysis digest.** `openlore analyze` writes a **Language coverage** section into
  `.openlore/analysis/CODEBASE.md` (`✓` backed, `·` fail-soft), scoped to the repo's detected
  languages.
- **The `get_language_support` MCP tool** (opt-in, `--preset full`). With no argument it returns the
  matrix for the repo's detected languages (an empty list when none are detected — never the whole
  registry); with a `language` it returns that one language's support as a pure registry lookup (no
  analysis required, fail-soft for unknown languages). The `language` argument is resolved
  **case-insensitively** and trimmed, so `"go"`, `"GO"`, and `" Go "` all resolve to `Go`. Classified
  as a `conclusion` tool; not in the lean/minimal first-run surface.

## Checklist: adding or widening a language

The registry record + its fixtures are the canonical, minimal path. To add a language `L`, or to widen
an existing one to a new capability:

1. **Wire the generic extractor for the capability** where one is data-driven:
   - `callGraph`: add an entry to `QUERY_LANG_SPECS` (`call-graph.ts`) with the grammar's node-type
     names, or a dedicated extractor for a native grammar; add `L` to `CALLGRAPH_LANGUAGES`.
   - `cfgOverlay`: add a `CfgLangSpec` to `SPEC_BY_LANGUAGE` (`cfg.ts`) — that is all `cfgOverlay`
     needs (the registry reads `cfgSupportsLanguage` directly).
   - `signatures`: add a case to `extractSignatures` (or an `EXTRA_LANG_PATTERNS` row) and add `L` to
     `SIGNATURE_LANGUAGES`.
   - `typeInference`: add a case to `inferTypesFromSource` and add `L` to `TYPE_INFERENCE_LANGUAGES`.
   - `imports`: extend the live `buildBaseImportMap` path and add `L` to `IMPORT_RESOLUTION_LANGUAGES`.
   - `iacProjection`: add the ecosystem to `IAC_LANGUAGES` and its projector under `analyzer/iac/`.
   - `crossServiceHttp`: add a client idiom to `extractHttpCalls` and/or a route framework to the
     route extractors (`extractRouteDefinitions`/`extractTsRouteDefinitions`/`extractJavaRouteDefinitions`),
     then add `L` to `HTTP_CLIENT_LANGUAGES` and/or `HTTP_ROUTE_LANGUAGES` (`http-route-parser.ts`);
     the union `CROSS_SERVICE_HTTP_LANGUAGES` drives the registry column.
   - `errorPropagation`: add an `L` branch to `specFor`/`getExceptionParser` in `exception-flow.ts`
     (the per-language throw/try/catch node-type spec + a tree-sitter parser) and add `L` to
     `ERROR_PROPAGATION_LANGUAGES`; drop an `ERRP_FIXTURES` entry in `language-support.test.ts`. Mind
     the language's catch semantics — typed catches need exact-name matching, untyped are catch-all.
2. **Make `detectLanguage` map the file** (extension or classification) to the canonical name `L`.
3. **Add `L` to the registry universe** if it is a brand-new name: `CODE_LANGUAGES` (extension-detected)
   — IaC ecosystem tags are derived automatically from `IAC_LANGUAGES`.
4. **Drop in a fixture** so the faithfulness test in `language-support.test.ts` exercises the new
   capability (the test asserts the claimed capability actually produces output — every member of
   every capability set is run through the live extractor). For a new `iacProjection` ecosystem, add
   it to the `contributors` map in that file's `iacProjection is behaviorally faithful` block so the
   real analyze pipeline must emit a node tagged with it — otherwise the guard fails, by design.
5. Run `npm run test:run`. The registry, the coverage matrix, and the `get_language_support` tool pick
   `L` up with **no new orchestration code** for the capabilities the generic extractors already
   implement.

The bar: the same languages extract the same nodes and edges as before, but "what we know about
language L" now lives in one declarative place, fail-soft is uniform, and coverage is queryable.
