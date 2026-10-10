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
| `receiverResolution` | Chained intra-object receiver resolution — `this.<field>.m()` / `self.<field>.m()` — through a per-file registry of declared field types (annotation, `new T()`, constructor parameter property, Python `__init__` annotation, class-body annotation, or `self.x = T()` construction — where a capitalized name the file declares as a `def` is a factory, not a class, and is refused) and locally-declared return types. A resolved call becomes a `receiver_inferred` edge; a receiver the registry cannot bind emits NO edge and is disclosed as a boundary by `analyze_error_propagation`, never guessed. Backed for TypeScript/JavaScript/Python. A language without it does not bind the shape; what it records instead is its own call query's business, and the three outcomes differ: Java/C# capture the chained receiver and fall through to ordinary member-call handling; **Go captures no chained receiver at all**, so it records nothing (a known open gap); and **Ruby is worse than either** — its call query matches only the receiverless alternative, so `self.repo.save` / `@repo.save` emit a raw edge carrying NO receiver, which then binds by `name_only` to any same-named method in the repository. All three are pre-existing and untouched here. | `RECEIVER_REGISTRY_LANGUAGES` (`receiver-registry.ts`) |
| `styleFingerprint` | Descriptive per-language idiom-frequency profile (function form, binding, conditional, async, string, naming case) with an evidence floor + enforcement-awareness. Backed for TypeScript/JavaScript/Python/Go. | `STYLE_FINGERPRINT_LANGUAGES` (`style-fingerprint.ts`) |
| `iacProjection` | Infrastructure-as-code projection (resources/edges) onto the unified graph. | `isIacLanguage()` / `IAC_LANGUAGES` (`iac/types.ts`) |
| `crossServiceHttp` | Cross-service API topology: outbound HTTP client call sites and/or server route registrations are matched into `http_endpoint` edges across the process (and, under federation, the repo) boundary. Clients: TS/JS (`fetch`/`axios`/`ky`/`got`), Python (`requests`/`httpx`), and Go (`net/http`); routes: TS/JS (Express/NestJS/Next), Python (FastAPI/Flask/Django), Java (Spring/JAX-RS). | `CROSS_SERVICE_HTTP_LANGUAGES` (`http-capability.ts`) |
| `dynamicBoundary` | Dispatch the resolver cannot follow — reflective invocation, computed-member dispatch, `eval`, dynamic import, metaprogrammed definition, DI-container resolution — recorded as a disclosed **boundary site** — unless `literalReflection` binds it to an edge. Backed for TypeScript/JavaScript/Python/Ruby/Go/Java/PHP/C#. A language WITHOUT it records no site because none is looked for, never because it contains no dynamic dispatch. | `DYNAMIC_BOUNDARY_LANG_SPECS` (`dynamic-boundary.ts`) |
| `literalReflection` | The structurally provable part of reflective dispatch becomes an edge: a **literal dispatch table** — `HANDLERS[k]()` / `HANDLERS["create"]()` over a module-private `const` object whose name is used nowhere in the file except its declaration, a type query, and as the receiver of an immediately invoked subscript, in a file that evaluates no code. Each entry binds by its same-file module-level function declaration (or `const` arrow), never by name; an imported, reassigned, or `this`-using entry keeps the construct a site. A variable key binds every entry or none (none over the synthesis fan-out cap); a literal key binds its own entry. Edges carry `confidence: 'synthesized'` and `synthesizedBy: 'literal-reflective'`; bound constructs are persisted separately so a directly-resolved-only conclusion still discloses them; a subset rebuild, or a file with more recorded constructs than the per-file retention bound, binds nothing. Self-typed receivers (`this["m"]()`, `getattr(self, "m")()`, Ruby `send(:m)`), bare-name reflection, DI-container resolution, and Python dicts are never resolved. Backed for TypeScript/JavaScript. | `supportsLiteralReflection()` over `DYNAMIC_BOUNDARY_LANG_SPECS` (`dynamic-boundary.ts`) |
| `errorPropagation` | Static exception escape/handler extraction for TypeScript, JavaScript, Python, Java, and C#; Java/C# typed handlers are exact-name lower bounds, with finally/resource-cleanup limits disclosed. Go uses a separate value-shaped model for proven returned-error positions and a narrow unconditional deferred-recover pattern; ambiguous result types, unwind ordering, and unresolved calls are boundaries, never exception terminology. | `ERROR_PROPAGATION_LANGUAGES` (`exception-flow.ts`) |

## The registry is derived, not hand-listed

The declarative registry (`src/core/analyzer/language-support.ts`) is the single source of truth for
"what we know about language L" — but it is **computed** from the same structures the extractors
consult at run time (the table above), never hand-maintained in parallel. So the coverage matrix
cannot silently drift from what the analyzer actually does. `language-support.test.ts` behaviorally
cross-checks **every member** of the `signatures`, `callGraph`, `complexity`, `imports`, `typeInference`,
`receiverResolution`, `cfgOverlay`, `styleFingerprint`, `crossServiceHttp`, `errorPropagation`, and
`dynamicBoundary` sets by running the real extractor on a per-language fixture and asserting it produces
output (a malformed entry that produced nothing fails the test, not just the predicate tautology);
`cfgOverlay` and `iacProjection` are additionally asserted exactly against their predicates
(`cfgSupportsLanguage`, `isIacLanguage`) for every language, and `iacProjection`'s per-ecosystem node
tagging is covered by the dedicated `iac/*.test.ts` suite and an end-to-end analyze check.
`literalReflection` is cross-checked in `literal-reflection.test.ts` instead: the claimed set must equal
the languages with a declared table rule, and each member must produce an edge on its fixture.

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

### Kotlin

What OpenLore does for Kotlin is a checked list, not a claim (issue #546). The plan is
`openspec/changes/KOTLIN-TOTAL-SUPPORT-2026-10.md`.

<!-- kotlin-support:start (generated from kotlin-reference/ledger.ts; do not edit by hand) -->

Each row is a fact about the Kotlin reference project (`src/core/analyzer/fixtures/kotlin-reference/`)
that a test checks on every run.

#### Supported (22)

| Area | Fact | Change |
|---|---|---|
| nodes | the member function `service/UserService.kt::UserService.create` is a graph node | `add-kotlin-reference-corpus-conformance` |
| nodes | the top-level function `repo/Stores.kt::openStore` is a graph node | `add-kotlin-reference-corpus-conformance` |
| nodes | the extension function `util/Strings.kt::slugify` is a graph node | `add-kotlin-reference-corpus-conformance` |
| nodes | the object member `config/Env.kt::Env.port` is a graph node | `add-kotlin-reference-corpus-conformance` |
| nodes | the interface member `repo/UserRepository.kt::UserRepository.save` is a graph node | `add-kotlin-reference-corpus-conformance` |
| call graph | `service/UserService.kt::UserService.describe` calls `service/UserService.kt::UserService.require` | `add-kotlin-reference-corpus-conformance` |
| call graph | `util/Strings.kt::loadName` calls `util/Strings.kt::load` | `add-kotlin-reference-corpus-conformance` |
| call graph | `Application.kt::module` calls `service/UserService.kt::UserService.create` | `add-kotlin-reference-corpus-conformance` |
| call graph | no call edge joins `client/OrderClient.kt::fetchHealth` to `web/UserController.kt::UserController.get`: `client.get(...)` is a Ktor client call | `add-kotlin-reference-corpus-conformance` |
| call graph | no call edge joins `web/UserController.kt::UserController.create` to `web/UserController.kt::UserController.create`: `this.service.create(name)` is a call on a property, not recursion | `fix-kotlin-package-binding-soundness` |
| call graph | no call edge joins `service/UserService.kt::UserService.find` to `service/UserService.kt::UserService.find`: `repo.find(id)` is a call on a property, not recursion | `fix-kotlin-package-binding-soundness` |
| call graph | no call edge joins `service/UserService.kt::UserService.require` to `service/UserService.kt::UserService.find`: `repo.find(id)` has the receiver `repo` | `fix-kotlin-package-binding-soundness` |
| call graph | no call edge joins `Application.kt::module` to `web/UserController.kt::UserController.get`: `get("/health") { }` is the Ktor routing function | `fix-kotlin-package-binding-soundness` |
| call graph | no call edge joins `plugin/Reflect.kt::startAll` to `util/Strings.kt::load`: `ServiceLoader.load(...)` has a receiver and `load` is private to another file | `fix-kotlin-package-binding-soundness` |
| call graph | no call edge joins `Application.kt::main` to `plugin/Reflect.kt::Plugin.start`: `embeddedServer(...).start(...)` has a receiver of a library type | `fix-kotlin-package-binding-soundness` |
| call graph | no call edge joins `service/UserService.kt::UserService.create` to `repo/UserRepository.kt::AuditedUserRepository.audit`: `audit(...)` is a property of `UserService`; the other `audit` is a private member of another class | `fix-kotlin-package-binding-soundness` |
| call graph | no call edge joins `service/UserService.kt::UserService.create` to `util/Strings.kt::listOf`: `listOf` is a Kotlin default import and the file does not import the project function | `fix-kotlin-package-binding-soundness` |
| call graph | no call edge joins `util/Strings.kt::listOf` to `util/Strings.kt::listOf`: `kotlin.collections.listOf(...)` is fully qualified | `fix-kotlin-package-binding-soundness` |
| call graph | `service/UserService.kt::UserService.label` calls `util/Strings.kt::slugify` (import) | `fix-kotlin-package-binding-soundness` |
| call graph | `service/UserService.kt::UserService.create` calls `util/Strings.kt::slugify` (import) | `fix-kotlin-package-binding-soundness` |
| call graph | `Application.kt::module` calls `repo/Stores.kt::openStore` (import) | `fix-kotlin-package-binding-soundness` |
| grammar | every source file of the reference project parses without a syntax error, at a declared language level | `harden-kotlin-grammar-currency` |

#### Known gaps (67)

A known gap is checked too: the test fails when a gap closes until the row moves to "Supported".

| Area | Fact | Change |
|---|---|---|
| call graph | `service/UserService.kt::UserService.create` calls `repo/UserRepository.kt::UserRepository.save` (type_inference or receiver_inferred or type_name or self_cls) | `add-kotlin-declared-type-receivers` |
| call graph | `service/UserService.kt::UserService.find` calls `repo/UserRepository.kt::UserRepository.find` (type_inference or receiver_inferred or type_name or self_cls) | `add-kotlin-declared-type-receivers` |
| call graph | `web/UserController.kt::UserController.get` calls `service/UserService.kt::UserService.find` (type_inference or receiver_inferred or type_name or self_cls) | `add-kotlin-declared-type-receivers` |
| call graph | `web/UserController.kt::UserController.create` calls `service/UserService.kt::UserService.create` (receiver_inferred) | `add-kotlin-declared-type-receivers` |
| call graph | `Application.kt::warmUp` calls `client/OrderClient.kt::OrderClient.fetch` (type_inference or receiver_inferred or type_name or self_cls) | `add-kotlin-declared-type-receivers` |
| call graph | `repo/UserRepository.kt::AuditedUserRepository.save` calls `repo/UserRepository.kt::UserRepository.save` (type_inference or receiver_inferred or type_name or self_cls) | `add-kotlin-declared-type-receivers` |
| capabilities | Kotlin backs the `receiverResolution` capability | `add-kotlin-declared-type-receivers` |
| nodes | the constructor `service/UserService.kt::UserService.<init>` is a graph node | `add-kotlin-callable-node-shapes` |
| call graph | `service/UserService.kt::UserService.<init>` calls `service/UserService.kt::UserService.warm` | `add-kotlin-callable-node-shapes` |
| call graph | `service/UserService.kt::UserService.inMemory` calls `service/UserService.kt::UserService.<init>` | `add-kotlin-callable-node-shapes` |
| call graph | `repo/Stores.kt::openStore` calls `repo/UserRepository.kt::AuditedUserRepository.<init>` | `add-kotlin-callable-node-shapes` |
| call graph | `service/UserService.kt::UserService.create` calls `service/UserService.kt::UserService.report` | `add-kotlin-callable-node-shapes` |
| call graph | `service/UserService.kt::UserService.create` calls `util/Strings.kt::tagged` | `add-kotlin-callable-node-shapes` |
| nodes | the property getter `service/UserService.kt::UserService.<get-summary>` is a graph node | `add-kotlin-callable-node-shapes` |
| call graph | `service/UserService.kt::UserService.<get-summary>` calls `service/UserService.kt::UserService.render` | `add-kotlin-callable-node-shapes` |
| nodes | the function-typed property `service/UserService.kt::UserService.audit` is a graph node | `add-kotlin-callable-node-shapes` |
| call graph | `service/UserService.kt::UserService.audit` calls `service/UserService.kt::UserService.record` | `add-kotlin-callable-node-shapes` |
| call graph | `service/UserService.kt::UserService.create` calls `service/UserService.kt::UserService.audit` | `add-kotlin-callable-node-shapes` |
| nodes | the top-level property initializer `repo/Stores.kt::<clinit>` is a graph node | `add-kotlin-callable-node-shapes` |
| nodes | the script body `build.gradle.kts::<script>` is a graph node | `add-kotlin-callable-node-shapes` |
| nodes | the backtick-named function, stored without backticks, `service/UserServiceTest.kt::UserServiceTest.creates a user with a slug id` is a graph node | `add-kotlin-callable-node-shapes` |
| nodes | the `suspend` function `warmUp` is marked asynchronous | `add-kotlin-callable-node-shapes` |
| classes | the class inventory has no class named `String` (an extension receiver is not a project class) | `fix-kotlin-type-hierarchy-fidelity` |
| classes | the extension function `slugify` records `String` as its receiver type | `fix-kotlin-type-hierarchy-fidelity` |
| classes | `InMemoryUserRepository` implements the interface `UserRepository` (it is not a superclass) | `fix-kotlin-type-hierarchy-fidelity` |
| classes | `AuditedUserRepository : UserRepository by inner` implements `UserRepository` and is marked delegating | `fix-kotlin-type-hierarchy-fidelity` |
| classes | class kinds are recorded: `Env` is an object, `User` a data class, `UserRepository` an interface, `Color` an enum | `fix-kotlin-type-hierarchy-fidelity` |
| classes | `AuditedUserRepository.save` overrides `UserRepository.save` | `fix-kotlin-type-hierarchy-fidelity` |
| signatures | the signature of `UserController.get` keeps `fun get(@PathVariable id: String): User?` after `@GetMapping("/{id}")` | `fix-kotlin-signature-and-kdoc-fidelity` |
| signatures | the signature of `safeDescribe` is `fun safeDescribe(id: String): String`, with no part of its expression body | `fix-kotlin-signature-and-kdoc-fidelity` |
| signatures | the KDoc of `UserController.get` is its docstring | `fix-kotlin-signature-and-kdoc-fidelity` |
| call graph | standard-library calls (`forEach`, `runCatching`, `lowercase`, `error`) are not external leaves | `fix-kotlin-signature-and-kdoc-fidelity` |
| control flow | `UserService.describe` has an overlay with a multi-way `when` branch, a `try` region, and an Elvis exit | `widen-kotlin-control-flow-overlay` |
| control flow | `UserService.require` (an expression body with an Elvis `throw`) has an overlay with a branch | `widen-kotlin-control-flow-overlay` |
| call graph | `legacy/LegacyCaller.java::LegacyCaller.store` calls `repo/Stores.kt::openStore` (import) | `add-kotlin-java-interop-resolution` |
| call graph | `legacy/LegacyCaller.java::LegacyCaller.port` calls `config/Env.kt::Env.port` (import) | `add-kotlin-java-interop-resolution` |
| call graph | `legacy/LegacyCaller.java::LegacyCaller.service` calls `service/UserService.kt::UserService.inMemory` (import) | `add-kotlin-java-interop-resolution` |
| multiplatform | the `actual fun platformName` is joined to its `expect` declaration by an `actualizes` relation | `add-kotlin-multiplatform-source-sets` |
| multiplatform | nodes record their source set (`commonMain`, `jvmMain`) | `add-kotlin-multiplatform-source-sets` |
| file graph | `UserService.kt` has an import edge to `UserRepository.kt` (`import com.acme.repo.UserRepository`) | `add-kotlin-file-dependency-and-exports` |
| file graph | `UserService.kt` has an import edge to `Strings.kt` (`import com.acme.util.slugify`) | `add-kotlin-file-dependency-and-exports` |
| file graph | `Application.kt` has an import edge to `Stores.kt` through `import com.acme.repo.*` (it uses `openStore`) | `add-kotlin-file-dependency-and-exports` |
| file graph | `LegacyCaller.java` has an import edge to `UserService.kt` | `add-kotlin-file-dependency-and-exports` |
| file graph | `Strings.kt` exports `slugify`, `loadName`, and `Color`, and does not export the private `load` | `add-kotlin-file-dependency-and-exports` |
| routes | Spring routes `GET /api/users/{id}` and `POST /api/users` are listed | `add-kotlin-http-topology` |
| routes | Ktor routes `GET /health`, `POST /users`, and `GET /users/{id}` are listed | `add-kotlin-http-topology` |
| capabilities | Kotlin backs the `crossServiceHttp` capability | `add-kotlin-http-topology` |
| schemas | the JPA entity `User` is listed as table `users` with columns `id` and `display_name` | `add-kotlin-schema-inventory` |
| schemas | the Exposed table `orders` is listed with columns `id`, `user_id`, and `total` | `add-kotlin-schema-inventory` |
| environment | `ACME_PORT` is listed as an optional read (`System.getenv("ACME_PORT") ?: "8080"`) | `add-kotlin-env-var-reads` |
| environment | `ACME_DATABASE_URL` (`?: error(...)`) and `ACME_TOKEN` (`getValue`) are listed as required reads | `add-kotlin-env-var-reads` |
| environment | `ACME_REGION` is listed from `providers.environmentVariable("ACME_REGION")` in the build script | `add-kotlin-env-var-reads` |
| inventories | the `@Composable` functions `Greeting` and `GreetingList` are listed as UI components | `add-kotlin-ui-and-middleware-inventories` |
| inventories | the Ktor plugin installation `install(CallLogging)` is listed as middleware | `add-kotlin-ui-and-middleware-inventories` |
| capabilities | Kotlin backs the `errorPropagation` capability | `add-kotlin-error-propagation` |
| capabilities | Kotlin backs the `dynamicBoundary` capability | `add-kotlin-dynamic-boundary` |
| capabilities | Kotlin backs the `styleFingerprint` capability | `add-kotlin-style-fingerprint` |
| public surface | the public surface lists `openStore` and `UserService`, and does not list the private `load` | `add-kotlin-public-surface` |
| tests | the Kotest spec `UserServiceSpec` has a test node for "safeDescribe falls back" that reaches `UserService.safeDescribe` | `add-kotlin-test-detection-and-generation` |
| call graph | `service/UserServiceTest.kt::UserServiceTest.describesMissingUser` calls `service/UserService.kt::UserService.describe` (type_inference or receiver_inferred or type_name or self_cls) | `add-kotlin-declared-type-receivers` |
| entry points | `main` in `Application.kt` is a root named by `application { mainClass.set("com.acme.ApplicationKt") }` | `add-kotlin-entry-point-roots` |
| entry points | the Spring handler `UserController.get` is a framework root, not a dead-code candidate | `add-kotlin-entry-point-roots` |
| identity | the project type is Kotlin | `add-kotlin-project-identity` |
| identity | Spring Boot and Ktor are detected as frameworks | `add-kotlin-project-identity` |
| identity | a source package directory named `android` is analyzed, not skipped as build output | `add-kotlin-project-identity` |
| identity | the Gradle build script is not a domain | `add-kotlin-project-identity` |
| search | search chunking splits a Kotlin file at declaration boundaries | `fix-kotlin-auxiliary-surface-parity` |

#### Out of scope

| Not supported | Reason |
|---|---|
| Type checking, smart casts, generic substitution, overload resolution by argument type | OpenLore reads syntax and declared types; these need a compiler front end. The affected calls are disclosed boundaries. |
| Compiling the project, running Gradle, reading resolved dependency graphs | Local-first and deterministic: no build is run. |
| Kotlin/JS, Kotlin/Native, and Kotlin/Wasm platform APIs | The language support is the same; platform library modeling is not in scope. |
| Generated code (kapt, KSP, Dagger, Room) | It is not in the repository. Its effect is covered by annotation roots. |
| SQLDelight `.sq` files and Android XML layouts | They are not Kotlin source. |
| The `iacProjection` capability | It applies to infrastructure formats, not to general-purpose languages. |
| The `literalReflection` capability | A Kotlin dispatch table is a map of callable references, and each reference is already an ordinary edge. |

<!-- kotlin-support:end -->

#### Kotlin syntax coverage

<!-- kotlin-syntax:start (generated from kotlin-syntax-corpus.ts; do not edit by hand) -->

Declared language level: **Kotlin 2.2**. Grammar: `tree-sitter-kotlin` 0.3.8.
A file that uses a known gap is reported by parse-health; its other declarations are still extracted.

| Feature | Stable since | Result |
|---|---|---|
| Functions: block and expression bodies, generics, extension, infix, tailrec, inline reified, vararg | 1.0 | clean |
| Classes: primary and secondary constructors, init, inheritance, companion, inner, object, data, enum, annotation, abstract | 1.0 | clean |
| Properties: accessors, delegates, lateinit, const, top-level | 1.0 | clean |
| Control flow: when, ranges, labels, do-while, try / catch / finally as expressions | 1.0 | clean |
| Lambdas, anonymous functions, function types with receiver, callable references, labeled return | 1.0 | clean |
| Null safety: safe call, Elvis, non-null assertion, safe and unsafe casts, smart casts | 1.0 | clean |
| Generics: variance, bounds, where clause, star projection, type alias | 1.1 | clean |
| Annotations: file target, use-site target, arguments with braces, class literal | 1.0 | clean |
| Coroutines: suspend functions and suspend function types | 1.3 | clean |
| Strings: templates, raw strings, character escapes | 1.0 | clean |
| Operator functions, destructuring declaration, compound assignment, in / !in | 1.0 | clean |
| Destructuring in loops, downTo / step, underscore for unused variables | 1.1 | clean |
| Sealed classes and interfaces, data object, value class | 1.9 | clean |
| Functional (SAM) interfaces: `fun interface` | 1.4 | clean (normalized before parsing) |
| Interface delegation (`by`) and delegated properties | 1.0 | clean |
| Object expressions (anonymous objects) | 1.0 | clean |
| Trailing commas | 1.4 | clean |
| Definitely non-nullable types: `T & Any` | 1.7 | clean |
| Underscore operator for type arguments | 1.7 | clean |
| Open-ended range operator: `..<` | 1.9 | clean (normalized before parsing) |
| Enum `entries` property | 1.9 | clean |
| Guard conditions in `when` with a subject | 2.2 | known gap: Kotlin 2.2. The grammar has no rule for `if` after a `when` condition; the `when` entry is an error region. |
| Multi-dollar string interpolation | 2.2 | clean (normalized before parsing) |
| Non-local `break` and `continue` in inline lambdas | 2.2 | clean |
| Soft keywords used as identifiers | 1.0 | clean |
| Local functions, local classes, anonymous functions | 1.0 | clean |

<!-- kotlin-syntax:end -->

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
keyword search, and skips graph extraction for that language without aborting analysis. Dart is the
only language served by a portable WASM grammar rather than the native lane, in an isolated WASM
module; if that backend is unavailable, it degrades in the same way.

Dart stays on WASM as a deliberate hold rather than for lack of an alternative. A native Dart
grammar does exist and parses byte-identically (issue #472), but the only fitting package is a
single-maintainer fork with negligible download volume, so the swap was declined on supply-chain
grounds — the WASM binaries in use come from a build with SLSA provenance instead. Revisit if a
well-supported native build appears.

Lua used to share that lane and no longer does: it moved to the maintained
`@tree-sitter-grammars/tree-sitter-lua` grammar on the native lane, which ships prebuilt bindings
for every supported platform. That migration is what lifted the `web-tree-sitter` pin — the old
`tree-sitter-wasms` binaries were rejected by every loader from 0.26 onward, with an empty-message
throw that silently removed both languages from the call graph — and it hands Lua two capabilities
the WASM lane cannot offer: trustworthy parse-health and an enforceable parse budget. Dart's
binaries moved to the `@repomix/tree-sitter-wasms` rebuild, whose parse trees are byte-identical to
the old ones. Both halves of the remaining lane are pinned exactly, and a guard test fails if
either is loosened to a range, so loader and binaries can never drift apart unreviewed.

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
   - `receiverResolution` (FIVE steps — the first two are easy to miss, and missing either fails
     silently rather than loudly):
     1. capture the chained receiver in `L`'s call query, setting `RawEdge.receiverField`;
     2. add an `L` branch to `collectReceiverFieldFacts` (`receiver-registry.ts`). Its dispatch is
        currently two-way (`Python` vs everything else), so a new language would otherwise fall
        into the **TypeScript** collector and be silently mis-parsed;
     3. add an `L` branch to `enclosingClassName` in the same file — its receiver-rebinding rules
        are TS-shaped and Python-shaped only, and a wrong owner is a FALSE EDGE, not a miss;
     4. teach `isSelfRootedMember` (`exception-flow.ts`) `L`'s member/wrapper node types, or the
        residue goes back to being silent while the matrix claims support;
     5. add `L` to `RECEIVER_REGISTRY_LANGUAGES` and drop a fixture into the `receiverResolution`
        behavioral test — and assert the BOUNDARY fires for an untypeable receiver, not only that
        a resolved edge appears.
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
