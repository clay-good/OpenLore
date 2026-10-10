# Total Kotlin support (issue #546), 2026-10-10

Issue [#546](https://github.com/clay-good/OpenLore/issues/546) asks for full Kotlin (JVM) support and
names `import-parser` as the gap. This document is the plan: 23 change proposals that take Kotlin
from "the call graph mostly works" to "every capability OpenLore has, proven by a test".

All 23 are specification only. Each one is built in its own pull request.

## What we found

Kotlin has seven of the fourteen capabilities in the language-support registry today (signatures,
call graph, test detection, complexity, imports, control-flow overlay, type inference). The issue
is right about `import-parser`, but that is one of many gaps, and it is not the most serious one.

We analyzed a small Kotlin project (15 files at its largest: Spring controller, Ktor module,
service, repository, JPA entity, extensions, a test, a multiplatform pair, a Gradle Kotlin build
script) with the built CLI, version 3.3.0. The results:

| Area | Result |
|---|---|
| **Wrong edges** | `this.service.create(name)` is recorded as a call from `UserController.create` to itself, with `import` confidence. `client.get("http://…")` on a Ktor client is recorded as a call to `UserController.get`, with `import` confidence. |
| **Missed edges** | Calls on an injected constructor property (`repo.save(x)`) and on a typed parameter are external leaves. Constructor calls (`UserService(repo)`) are external. Calls in `init` blocks, property accessors, callable references (`::report`), and infix calls give no edge. |
| **Effect** | At the 8-file stage, 38 of 39 symbols have no reaching test. Most service functions are reported as entry points. |
| File dependency graph | No import edges and no exports for any Kotlin file. |
| Inventories | Routes 0 (five exist), schemas 0 (one entity), environment variables 0 (two reads), frameworks 0. |
| Conclusions | Error propagation: "not supported for Kotlin". Style fingerprint: "not found". Public surface: empty and marked **complete**. |
| Identity | Project type "Java". Language breakdown "KT 85%, KTS 8%". `build.gradle.kts` became a domain named `build-gradle`. |
| Skipped source | Package directories named `android` and `target` were skipped as build output. |
| Documentation | No KDoc is extracted. A signature with `@GetMapping("/{id}")` is cut at the brace. |
| Multiplatform | An `actual` function has no link to its `expect` declaration and looks dead. |
| Grammar | `tree-sitter-kotlin` 0.3.8 (2024-08) reports errors on `fun interface`, `..<`, `when` guards, and multi-dollar strings. |
| Tests | Path rules only. Kotest specs have no test nodes. `generate_tests` writes Java for a Kotlin project. |

## The 23 changes

Build order is top to bottom. A phase can be built in parallel inside itself.

### Phase 0: the oracle and the wrong answers

| Change | What it does | Domains |
|---|---|---|
| `add-kotlin-reference-corpus-conformance` | A realistic Kotlin fixture project plus a ledger of expected facts. A known gap that closes must be promoted; an asserted fact cannot regress. Defines when #546 is closed. | `analyzer` |
| `fix-kotlin-package-binding-soundness` | Removes the wrong `import` edges. Indexes only real package-level declarations; a call with a receiver never binds through the package-function index. Adds wildcard, alias, top-level function, and default imports. | `analyzer` |
| `harden-kotlin-grammar-currency` | A syntax corpus against a declared Kotlin language level, a known-gaps table, and a recorded decision before any grammar swap. | `analyzer` |

### Phase 1: the call graph

| Change | What it does | Domains |
|---|---|---|
| `add-kotlin-declared-type-receivers` | Resolves calls through declared types: parameters, constructor properties, class properties, return types. Kotlin gains `receiverResolution`. | `analyzer` |
| `add-kotlin-callable-node-shapes` | Nodes for constructors, `init` blocks, accessors, script bodies, lambda properties. Edges for constructor calls, callable references, infix calls. Operator calls are a disclosed boundary. | `analyzer` |
| `fix-kotlin-type-hierarchy-fidelity` | Extension receivers stop creating fake classes. Interfaces, delegation (`by`), object expressions, companions, nested classes, class kinds. | `analyzer` |
| `fix-kotlin-signature-and-kdoc-fidelity` | Signatures from the parse tree, structured parameters and modifiers, KDoc, standard-library call noise. | `analyzer` |
| `widen-kotlin-control-flow-overlay` | `when`, `try`, `do-while`, Elvis, safe call, labeled jumps, expression-position branches. | `analyzer` |
| `add-kotlin-java-interop-resolution` | Java calls reach Kotlin through JVM-facing names (`MainKt`, `Companion`, `INSTANCE`, accessors, `@JvmName`). | `analyzer` |
| `add-kotlin-multiplatform-source-sets` | Source sets, and `expect` / `actual` linking for reachability, impact, dead code, and clones. | `analyzer` |

### Phase 2: files and inventories

| Change | What it does | Domains |
|---|---|---|
| `add-kotlin-file-dependency-and-exports` | The `import-parser` work the issue names: Kotlin imports resolved by declared package, exports by declared visibility, Java and Kotlin in one index. | `analyzer` |
| `add-kotlin-http-topology` | Routes (Spring annotations and functional router, JAX-RS, Ktor DSL) and clients (Ktor, OkHttp, Retrofit, Spring, JDK). Kotlin gains `crossServiceHttp`. | `analyzer` |
| `add-kotlin-schema-inventory` | JPA, Spring Data relational, Room, Exposed. | `analyzer` |
| `add-kotlin-env-var-reads` | `System.getenv` forms, dotenv-kotlin, Gradle providers, with required or optional per site. | `analyzer` |
| `add-kotlin-ui-and-middleware-inventories` | Compose components; Ktor plugins, Spring filters and interceptors, JAX-RS filters. | `analyzer` |

### Phase 3: conclusions

| Change | What it does | Domains |
|---|---|---|
| `add-kotlin-error-propagation` | Throw sites, typed catches, `runCatching`, standard-library contract calls, inline-lambda rule. Kotlin gains `errorPropagation`. | `analyzer` |
| `add-kotlin-dynamic-boundary` | Reflection, service loading, Spring / Koin / Kodein lookups, script evaluation, proxies. Kotlin gains `dynamicBoundary`. | `analyzer` |
| `add-kotlin-style-fingerprint` | Five idioms on the existing closed set. Kotlin gains `styleFingerprint`. | `analyzer` |
| `add-kotlin-public-surface` | Kotlin surface membership and compatibility verdicts; an unassessed language is never reported "complete". | `mcp-handlers` |

### Phase 4: tests, roots, identity

| Change | What it does | Domains |
|---|---|---|
| `add-kotlin-test-detection-and-generation` | Source-set and content test detection, Kotest test nodes, Kotlin test generation. | `analyzer`, `generator` |
| `add-kotlin-entry-point-roots` | Gradle, Android manifest, Ktor config adapters; framework-annotation roots; overrides of library types. | `analyzer` |
| `add-kotlin-project-identity` | Project type "Kotlin", language names, JVM framework detection, position-aware skip rules, build scripts are not domains. | `project`, `analyzer` |
| `fix-kotlin-auxiliary-surface-parity` | Nine small Java-only lists fixed, and a guard test that fails on the next one. | `analyzer` |

## Dependencies

| Change | Needs first |
|---|---|
| every change | `add-kotlin-reference-corpus-conformance` (its ledger is the acceptance test) |
| `add-kotlin-declared-type-receivers` | `fix-kotlin-package-binding-soundness` |
| `add-kotlin-java-interop-resolution` | `fix-kotlin-package-binding-soundness`, `add-kotlin-callable-node-shapes` |
| `add-kotlin-public-surface` | `add-kotlin-file-dependency-and-exports`, `fix-kotlin-signature-and-kdoc-fidelity` |
| a grammar swap (inside `harden-kotlin-grammar-currency`) | the reference corpus, for the before/after diff |

The other changes are independent. `add-kotlin-error-propagation`, `add-kotlin-http-topology`, and
`add-kotlin-entry-point-roots` give better results after Phase 1, because they follow call edges.

## Rules every change follows

1. **Unique binding or no edge.** No Kotlin change adds a path that guesses.
2. **Import gates for frameworks.** A route, schema, middleware, or container lookup is recognized
   only in a file that imports the framework. A same-named project function is never taken for it.
3. **Unmodeled is named.** A file that imports a known framework that OpenLore does not model is
   counted in a receipt. A quiet result is then readable.
4. **A capability is claimed only with a fixture.** The registry is derived from the extractors, so
   the matrix cannot over-claim.
5. **Node identifiers are stable.** A change that adds nodes proves that existing identifiers did
   not move, so anchored memories and decisions carry forward.
6. **Evidence in the pull request.** Each change reports a before/after structural diff on the
   reference project and on at least one real Kotlin repository.

## The target

When all 23 are built, the Kotlin row of the registry backs every capability except two:

| Capability | Why not |
|---|---|
| `iacProjection` | It applies to infrastructure formats, not to general-purpose languages. |
| `literalReflection` | Deliberate. A Kotlin dispatch table is a map of callable references, and each reference is already an ordinary edge. |

Issue #546 is closed when the reference ledger has no `known-gap` entry and the capability target
has no missing capability.

## Deliberately not in this set

| Not included | Reason |
|---|---|
| Java gaps found on the way (HTTP clients, environment reads, public surface, middleware) | The issue is about Kotlin. Gates and patterns are written JVM-wide so Java can adopt them. `add-kotlin-public-surface` makes the Java gap visible instead of silent. |
| Type checking, smart casts, generic substitution, overload resolution by argument type | OpenLore reads syntax and declared types. These need a compiler front end. The affected calls are disclosed boundaries. |
| Compiling the project, running Gradle, reading resolved dependency graphs | Local-first and deterministic: no build is run. |
| Kotlin/JS, Kotlin/Native, and Kotlin/Wasm platform APIs | The language support is the same; platform library modeling is not in scope. |
| Generated code (kapt, KSP, Dagger, Room) | Not in the repository. Its effect is covered by annotation roots. |
| SQLDelight `.sq` and Android XML layouts | Not Kotlin source. |

Open proposals that already list languages (`add-deprecation-propagation`,
`add-message-topology-edges`) include Kotlin and need no change here.

## How the evidence was collected

- The fixture project was analyzed with `openlore analyze --no-embed`, and the node, edge, class,
  and inventory tables were read from the artifacts.
- Two read-only source audits listed every language or extension switch in `src/` and what Kotlin
  gets from it. The file and line references in each proposal come from those audits and were
  checked against the tree at commit `63ac23518`.
- Grammar results come from parsing one-line samples with the installed `tree-sitter-kotlin` 0.3.8.

Line numbers will move. Each proposal names the function or constant as well as the line.
