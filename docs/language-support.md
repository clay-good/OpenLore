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
| `complexity` | Grammar-shaped lexical estimation of per-function cyclomatic complexity for triage and ranking. Unsupported languages carry no complexity value. | `COMPLEXITY_LANGUAGES` (`call-graph-complexity.ts`) |
| `imports` | Import/package resolution into the `import`-confidence cross-file edge path. TS/JS follows re-export/barrel chains; Python resolves leading-dot modules; Go resolves imported packages and same-package siblings; Java/Kotlin/C#/PHP resolve statically bindable `import`/`using`/`use` bindings from package or namespace declarations. Ruby remains name-only because its load forms do not statically bind names. | `IMPORT_RESOLUTION_LANGUAGES` (`import-resolver-bridge.ts`) |
| `cfgOverlay` | A control-flow-graph overlay (branches/loops) via the data-driven CFG language table and grammar-shape adapters. | `cfgSupportsLanguage()` (`cfg.ts`) |
| `typeInference` | Lightweight receiver-type inference, used to resolve method calls to their class. | `TYPE_INFERENCE_LANGUAGES` (`type-inference-engine.ts`) |
| `styleFingerprint` | Descriptive per-language idiom-frequency profile (function form, binding, conditional, async, string, naming case) with an evidence floor + enforcement-awareness. Backed for TypeScript/JavaScript/Python/Go. | `STYLE_FINGERPRINT_LANGUAGES` (`style-fingerprint.ts`) |
| `iacProjection` | Infrastructure-as-code projection (resources/edges) onto the unified graph. | `isIacLanguage()` / `IAC_LANGUAGES` (`iac/types.ts`) |
| `crossServiceHttp` | Cross-service API topology: outbound HTTP client call sites and/or server route registrations are matched into `http_endpoint` edges across the process (and, under federation, the repo) boundary. Clients: TS/JS (`fetch`/`axios`/`ky`/`got`), Python (`requests`/`httpx`), and Go (`net/http`); routes: TS/JS (Express/NestJS/Next), Python (FastAPI/Flask/Django), Java (Spring/JAX-RS). | `CROSS_SERVICE_HTTP_LANGUAGES` (`http-capability.ts`) |
| `dynamicBoundary` | Dispatch the resolver cannot follow — reflective invocation, computed-member dispatch, `eval`, dynamic import, metaprogrammed definition, DI-container resolution — recorded as a disclosed **boundary site**, never resolved into an edge. Backed for TypeScript/JavaScript/Python/Ruby/Go/Java/PHP/C#. A language WITHOUT it records no site because none is looked for, never because it contains no dynamic dispatch. | `DYNAMIC_BOUNDARY_LANG_SPECS` (`dynamic-boundary.ts`) |
| `errorPropagation` | Static exception escape/handler extraction for TypeScript, JavaScript, Python, Java, and C#; Java/C# typed handlers are exact-name lower bounds, with finally/resource-cleanup limits disclosed. Go uses a separate value-shaped model for proven returned-error positions and a narrow unconditional deferred-recover pattern; ambiguous result types, unwind ordering, and unresolved calls are boundaries, never exception terminology. | `ERROR_PROPAGATION_LANGUAGES` (`exception-flow.ts`) |

## The registry is derived, not hand-listed

The declarative registry (`src/core/analyzer/language-support.ts`) is the single source of truth for
"what we know about language L" — but it is **computed** from the same structures the extractors
consult at run time (the table above), never hand-maintained in parallel. So the coverage matrix
cannot silently drift from what the analyzer actually does. `language-support.test.ts` behaviorally
cross-checks **every member** of the `signatures`, `callGraph`, `complexity`, `imports`, `typeInference`,
`cfgOverlay`, `styleFingerprint`, `crossServiceHttp`, `errorPropagation`, and `dynamicBoundary` sets by running the real extractor on a per-language fixture and asserting it produces
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

## Supported languages

OpenLore extracts a static call graph using the same `FunctionNode`, `CallEdge`, and `ClassNode`
primitives for every language below. A call becomes an edge only when its target resolves to a
function declared in the project. Dynamic dispatch, reflection, `eval`, and computed or variable
call targets emit no edge rather than a guessed one.

| Language | Extensions | Grouping | Notes |
|---|---|---|---|
| TypeScript | `.ts` `.tsx` `.mts` `.cts` | classes | TSX uses the TSX grammar. |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | classes | Parsed by the TypeScript extractor. |
| Python | `.py` | classes | — |
| Go | `.go` | structs (file-module) | — |
| Rust | `.rs` | impl/traits | — |
| Ruby | `.rb` | classes/modules | — |
| Java | `.java` | classes/interfaces | — |
| C++ | `.cpp` `.cc` `.cxx` `.hpp` `.h` | classes/namespaces | `.h` defaults to C++; see below. |
| Swift | `.swift` | classes/structs | — |
| C# | `.cs` | namespace/class/struct/record/interface | Methods, constructors, and local functions. |
| Kotlin | `.kt` `.kts` | class/object/interface/companion | Extension functions record the receiver type in `className`. |
| PHP | `.php` `.phtml` | class/trait/interface/enum | Instance, static, and free-function calls. |
| C | `.c` `.h` | file scope | Functions and calls; no classes. |
| Scala | `.scala` `.sc` | object/class/trait | Methods plus instance and object calls. |
| Dart | `.dart` | class/mixin/extension/enum | Functions, methods, and constructors. |
| Lua | `.lua` | file scope | Named, local, dotted, and method functions. |
| Elixir | `.ex` `.exs` | `defmodule` | Multi-clause definitions collapse to one node with a clause count. |
| Bash | `.sh` `.bash` | file scope | Edges target project-defined functions, not external binaries. |

### Script containers

Vue (`.vue`), Svelte (`.svelte`), and Astro (`.astro`) are recognized script containers. Their support
records distinguish direct container semantics from the capabilities backed inside extracted scripts.
OpenLore extracts plain `<script>` blocks through the JavaScript lane and `<script lang="ts">` blocks
through the TypeScript lane. The surrounding file is blanked without changing offsets or newlines, so
functions, calls, signatures, CFG, and style facts retain their true container-file positions.
`get_language_support` accepts the format name or extension (for example, `.svelte`) and reports those
script-scoped capabilities alongside the remaining container limitations.

Template expressions, framework macros, and Svelte reactive statements remain unanalyzed. Analyze,
orient, and doctor disclose that boundary and report the number of container files and script blocks;
they never treat a function reached only through framework magic as proven dead.
Container files over 1,000,000 characters are excluded before parser-lane allocation and reported as
`size-cap` parse-health exclusions.

### The `.h` rule

Both C and C++ claim `.h` headers. A header in a project containing any C++ source (`.cpp`, `.cc`,
`.cxx`, or `.hpp`) is C++; a header in a project with C sources and no C++ source is C; and a
standalone or ambiguous header defaults to C++. The C++ grammar is a superset, so this bias avoids
losing templates and namespaces.

### Graceful grammar degradation

If a native grammar is unavailable or ABI-incompatible, OpenLore warns once, keeps the file in
keyword search, and skips graph extraction for that language without aborting analysis. Lua and
Dart use portable WASM grammars because their native builds do not match the pinned host binding.
Each uses an isolated WASM module; if that backend is unavailable, they degrade in the same way.

### Out of scope

SQL, R, MATLAB, HTML/CSS markup, and Markdown/JSON/YAML configuration are not call-graph-shaped (except
where a format is explicitly supported as Infrastructure-as-Code). Deferred general-purpose
languages include Objective-C, Perl, Haskell, Clojure, F#, Groovy, OCaml, Zig, Nim, Julia, Erlang,
VB.NET, PowerShell, Fortran, and COBOL.

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
   - `complexity`: add a grammar-shaped decision pattern to `CC_PATTERNS`
     (`call-graph-complexity.ts`) and a shape fixture to `call-graph-complexity.test.ts`.
   - `cfgOverlay`: add a `CfgLangSpec` to `SPEC_BY_LANGUAGE` (`cfg.ts`), including a small
     grammar-shape adapter when the language uses positional control-flow nodes; the registry reads
     `cfgSupportsLanguage` directly.
   - `signatures`: add a case to `extractSignatures` (or an `EXTRA_LANG_PATTERNS` row) and add `L` to
     `SIGNATURE_LANGUAGES`.
   - `typeInference`: add a case to `inferTypesFromSource` and add `L` to `TYPE_INFERENCE_LANGUAGES`.
   - `imports`: extend the live `buildBaseImportMap` path and add `L` to `IMPORT_RESOLUTION_LANGUAGES`.
   - `iacProjection`: add the ecosystem to `IAC_LANGUAGES` and its projector under `analyzer/iac/`.
   - `crossServiceHttp`: add a client idiom to `extractHttpCalls` and/or a route framework to the
     route extractors (`extractRouteDefinitions`/`extractTsRouteDefinitions`/`extractJavaRouteDefinitions`),
     then add `L` to `HTTP_CLIENT_LANGUAGES` and/or `HTTP_ROUTE_LANGUAGES` (`http-capability.ts`);
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
