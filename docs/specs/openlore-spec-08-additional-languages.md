# OpenLore Spec 08 — Additional General-Purpose Languages (C#, Kotlin, PHP, C, Scala, Dart, Lua, Elixir, Bash)

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.

---

## Context for you (the agent)

OpenLore is graph-native: it models a codebase as functions (nodes) and calls (edges), then serves orientation questions over that graph — `orient`, `search_code`, `get_subgraph`, `analyze_impact`, `trace_execution_path`, `suggest_insertion_points`. The whole product rests on one extraction stage: per file, a tree-sitter grammar parses the source, a `*_FN_QUERY` extracts function/method declarations into `FunctionNode`s, and a `*_CALL_QUERY` extracts call sites into `CallEdge`s. Everything downstream — search index, SCIP export (spec-04), federation manifest (spec-05), MCP tools — consumes that one graph.

Today OpenLore extracts call graphs for **nine** general-purpose languages: TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, C++, and Swift. Spec-07 added Infrastructure-as-Code on top of the same primitives.

This spec closes the most painful remaining gaps in **general-purpose** coverage. The gaps fall into two buckets, and you must understand the difference before writing a line:

1. **Phantom languages — detected but dropped.** `detectLanguage` ([src/core/analyzer/signature-extractor.ts:39](../../src/core/analyzer/signature-extractor.ts#L39)) already returns `Kotlin` for `.kt`, `PHP` for `.php`, `C#` for `.cs`, and `C` for `.c`. But [call-graph.ts](../../src/core/analyzer/call-graph.ts) loads no grammar for any of them and the per-language dispatch ([call-graph.ts:389-489](../../src/core/analyzer/call-graph.ts#L389)) has no branch for them, so every one of these files is parsed into **nothing**. A user with a C# or Kotlin or PHP repo runs `openlore analyze`, sees files counted, and gets an empty graph for them. This is worse than "unsupported" — it is silently, confidently wrong. **Note also:** `C` is detected but even C++'s grammar is not invoked for it (the dispatch at [call-graph.ts:425](../../src/core/analyzer/call-graph.ts#L425) lists `C++` only). Closing this bucket is the highest-value, lowest-risk work in the spec.

2. **New languages — not detected at all.** Scala, Dart, Lua, Elixir, and Bash/Shell return `unknown` from `detectLanguage` and are dropped at detection time. These are the next tier of "popular and call-graph-shaped" languages with mature tree-sitter grammars.

### Why these languages, and why these only

The selection criterion is deliberate and you should hold the line on it: **a language is in scope iff (a) it is widely used, (b) it has a mature, npm-installable tree-sitter grammar consistent with the existing nine, and (c) its programs are genuinely call-graph-shaped** (functions/methods that call other functions/methods — the thing OpenLore's node/edge model expresses). The nine languages below all pass. Languages that fail criterion (c) — SQL (set logic, not call graphs), R and MATLAB (interactive/vectorized data work with weak intra-project call structure), HTML/CSS (not executable) — are **out of scope** no matter how popular. Languages that fail (a) or (b) for now — Objective-C, Perl, Haskell, Clojure, F#, Groovy, OCaml, Zig, Nim, Julia, Erlang, Visual Basic — are **deferred** (see "Out of scope"). Do not silently expand the set; if you believe one of the deferred languages belongs in this PR, say so in the PR description and leave it deferred unless told otherwise.

The nine **in scope** for this one PR:

| Language | Extensions | Bucket | Grammar package | Notes |
|---|---|---|---|---|
| **C#** | `.cs` | phantom (detected, dropped) | `tree-sitter-c-sharp` | Huge .NET ecosystem; methods, classes, namespaces. |
| **Kotlin** | `.kt`, `.kts` | phantom | `tree-sitter-kotlin` | Android/JVM; functions, classes, extension functions. |
| **PHP** | `.php`, `.phtml` | phantom | `tree-sitter-php` | Web; functions, methods, `$this->m()`, `Class::m()`. |
| **C** | `.c`, `.h` | phantom (detected, no dispatch) | `tree-sitter-c` | Functions + calls. Note `.h` collision with C++ (below). |
| **Scala** | `.scala`, `.sc` | new | `tree-sitter-scala` | JVM; `def`, `object`, `class`, `trait`. |
| **Dart** | `.dart` | new | `tree-sitter-dart` | Flutter; functions, methods, classes. |
| **Lua** | `.lua` | new | `tree-sitter-lua` | Scripting/embedding; `function`, `local function`, table methods. |
| **Elixir** | `.ex`, `.exs` | new | `tree-sitter-elixir` | BEAM; `def`/`defp` inside `defmodule`, `Mod.fun()` calls. |
| **Bash/Shell** | `.sh`, `.bash` | new | `tree-sitter-bash` | Function definitions and function-name call sites. |

This is the decision to record before writing code (see `record_decision`): *additional general-purpose language support is added by following the existing tree-sitter extractor pattern exactly — one lazy grammar loader, one `*_FN_QUERY`, one `*_CALL_QUERY`, one dispatch branch per language — with no change to the graph schema, the MCP tools, or `orient`. Phantom languages (detected but never parsed) are the priority; closing them is a bug fix as much as a feature.*

## Scope contract — do not break these things

This PR must NOT:

- Change the `FunctionNode` / `CallEdge` / `ClassNode` schema, the MCP tools, `orient`, the search index, SCIP export, or the federation manifest. New languages ride entirely on the existing primitives and the existing extraction pipeline.
- Regress any of the existing nine languages. Their grammars, queries, dispatch, and **byte-identical graph output** on unchanged inputs must be preserved. Lock this with the existing test suite plus a snapshot of the OpenLore repo's own graph before/after.
- Attempt semantic resolution beyond what the existing extractors do. OpenLore's call edges are **name-based and best-effort** (it matches callee names to declared functions, with confidence; it does not do full type resolution or overload resolution). New languages match that bar exactly — do not build a type checker. Where a call target is genuinely unresolvable statically (dynamic dispatch, reflection, `eval`, computed method names), emit **no edge** rather than a wrong one, and leave a `TODO(spec-08-followup): …`.
- Require any external toolchain (`dotnet`, `kotlinc`, `php`, `gcc`, `scalac`, `dart`, `lua`, `mix`, `bash`) at analyze time. Static parsing only.
- Add grammars that don't build cleanly across the CI platforms the existing grammars build on. Each tree-sitter grammar is a **native module**; if a grammar fails to build or install on a supported platform, that language must degrade gracefully (see "Graceful degradation") — never crash `analyze`.

This PR must:

- Add call-graph extraction for **all nine** languages above in **one PR**.
- Fix the phantom-language bug as part of this work: C#, Kotlin, PHP, and C must go from "counted but empty graph" to "real nodes and edges."
- Make each language **discoverable end to end**: extensions mapped by `detectLanguage`, files walked, parsed into nodes+edges, merged into the graph, indexed for search, and surfaced by every MCP tool with **zero tool-side changes**.
- Be deterministic: re-analyzing an unchanged tree produces an identical graph (stable node ids, sorted edges) for every new language.
- Keep `call-graph.ts` maintainable. It is a high-fan-in hub ([CallGraphBuilder.build](../../src/core/analyzer/call-graph.ts) has fanOut 49 per the codebase digest). Follow the existing in-file pattern (lazy loader + query constants + extractor function + dispatch branch) so the change reads like the surrounding code; do **not** refactor the existing language handlers while you are here.

## The extractor pattern you must follow (read this before coding)

Every existing language is wired in exactly four places. Replicate this for each new language; deviating from it is the most likely way to introduce a regression.

1. **Lazy grammar loader** ([call-graph.ts:255-341](../../src/core/analyzer/call-graph.ts#L255)). A module-level `let _XxxLanguage: object | undefined;` plus a `getXxxParser()` that dynamic-`import()`s the grammar once, calls `setLanguage`, and caches the parser. Match the existing shape exactly, including the `(module.default as …)` unwrapping each grammar needs (TypeScript's is `.typescript`; most others are `.default`; **verify each grammar's actual export shape** — they differ, and getting this wrong yields a runtime crash, not a type error).

2. **Detection** (`detectLanguage`, [signature-extractor.ts:39](../../src/core/analyzer/signature-extractor.ts#L39)). For the new languages, add the extension cases. For the phantom languages the case already exists — do **not** duplicate it. Handle the `.h` ambiguity explicitly (see below).

3. **Query constants.** Two tree-sitter queries per language, named `<LANG>_FN_QUERY` (captures function/method/class declarations with their names and `@name`/`@body` nodes for line ranges) and `<LANG>_CALL_QUERY` (captures call expressions and the callee identifier). Model these on the closest existing language: C# / Kotlin / Scala / Dart → study the **Java** and **TypeScript** queries (class-with-methods, `obj.method()`); C → study **C++** (C is a subset; the C++ query may largely transfer); PHP → **Java**/**Ruby** hybrid (`$this->m()`, `Class::m()`, free functions); Lua → **Python**-like (functions + table-method `t.f()` / `t:m()`); Elixir → **Ruby**-like (`defmodule`/`def`, `Mod.fun()`); Bash → simplest (function definitions; calls are bare command words matching a defined function name).

4. **Dispatch branch** ([call-graph.ts:389-489](../../src/core/analyzer/call-graph.ts#L389)). Add `if (language === 'C#') { … }` etc., calling a per-language `extractXxx(...)` that runs the two queries and returns `{ functions, calls, classes }` in the same shape every existing extractor returns. Where a new language is structurally identical to an existing one, you **may** route it through a shared generic extractor (e.g. the Java-style class/method extractor) parameterized by the query constants — but only if it does not perturb the existing language's output. When in doubt, copy rather than abstract; this file values locality.

### The `.h` problem (must handle explicitly)

`.h` headers are claimed by **both** C and C++ (`detectLanguage` currently returns `C++` for `.h`). Do not regress C++ projects. Resolution rule, in order:
- A `.h` in a project that contains any `.cpp`/`.cc`/`.cxx` → treat as **C++** (current behavior; keep it).
- A `.h` in a project with `.c` files and no C++ files → treat as **C**.
- Ambiguous / standalone `.h` → default to **C++** (status quo; C++ grammar is a superset and parses C headers acceptably).
Implement this as a small, tested heuristic. Because the C++ grammar is a superset, misclassifying a C header as C++ is low-harm; the reverse (a C++ header as C) loses templates/namespaces, so bias toward C++. Document the rule in `docs/language-support.md`.

## Per-language deliverables and gotchas

Implement in this order. The phantom languages first (they are bug fixes and the highest value); then the new languages.

### Phantom-language fixes (priority 1)

1. **C#** — `namespace`/`class`/`struct`/`record`/`interface` → grouping (`ClassNode`); `method`/`constructor`/`local function`/property accessors → `FunctionNode`. Calls: `obj.Method()`, `Class.StaticMethod()`, `this.M()`, `base.M()`. Gotchas: top-level statements (C# 9+, methods at file scope); partial classes (one logical class across files — link members, don't duplicate the class); LINQ method chains; `async`/`await`; expression-bodied members (`=> expr`).

2. **Kotlin** — `fun` (top-level, member, **extension** functions), `class`/`object`/`interface`/`data class`/`companion object` → grouping; `obj.m()`, `Class.m()`, top-level function calls. Gotchas: extension functions (`fun Foo.bar()` — name is `bar`, receiver is `Foo`; record receiver in `className`/signature, don't drop it); lambdas with trailing-lambda syntax; `companion object` members; default args.

3. **PHP** — `function` (free), `class`/`trait`/`interface`/`enum` with methods → grouping; calls: free `foo()`, `$this->m()`, `$obj->m()`, `Class::staticM()`, `self::m()`, `parent::m()`. Gotchas: PHP files mixing HTML and `<?php … ?>` (the grammar handles the islands — parse only PHP regions); namespaces (`\App\Foo`); variable functions (`$fn()` — unresolvable, drop); magic methods.

4. **C** — `function_definition` → `FunctionNode`; `call_expression` → edges. No classes (use file/translation-unit as the implicit grouping; do **not** invent classes). Gotchas: macros that look like calls (best-effort; `#define`d function-like macros are not reliably resolvable — drop unresolved); function pointers (`(*fp)()` — drop); K&R-style decls (rare; tolerate). Wire C through the dispatch and the `.h` heuristic above.

### New languages (priority 2)

5. **Scala** — `def` (methods/functions), `object`/`class`/`trait`/`case class` → grouping; calls `obj.m()`, `Obj.m()`, infix/operator methods (extract the common `a.m(b)` form; infix `a m b` is lower priority — `TODO(spec-08-followup)` if it balloons). Gotchas: implicit/given; for-comprehensions desugaring (ignore — parse surface calls); package objects.

6. **Dart** — top-level functions, `class`/`mixin`/`extension`/`enum` methods, constructors (incl. named `Foo.named()`); calls `obj.m()`, `Class.m()`, top-level `f()`. Gotchas: named/optional params; cascades (`..m()` — resolve the method name); async/`Future`; widget `build()` trees (just calls — fine).

7. **Lua** — `function name() … end`, `local function`, `function t.f()` / `function t:m()` (the `:` form has implicit `self`); calls `f()`, `t.f()`, `t:m()`. Gotchas: everything is a table (no real classes — model `t.f`/`t:m` by their table name in `className`, best-effort); functions assigned to fields (`t.f = function() end`); metatables/OO frameworks (drop what you can't resolve).

8. **Elixir** — `defmodule` → grouping (`ClassNode`), `def`/`defp`/`defmacro` → `FunctionNode`; calls: local `fun(args)`, remote `Mod.fun(args)`, piped `arg |> fun()`. Gotchas: arity matters in Elixir (`fun/2`) — include arity in the signature and, where cheap, in name disambiguation; pattern-matched multi-clause functions (multiple `def foo` with different heads → one logical node, note clause count in signature, do not emit N duplicate nodes); macros that generate functions (unresolvable — drop).

9. **Bash/Shell** — `function f { … }` / `f() { … }` → `FunctionNode`; calls = command words that match a **defined** function name within the project (do not emit edges to external binaries like `ls`/`grep` — those are not project functions; treat them as external/ignored, consistent with how `isIgnoredCallee` filters builtins elsewhere). Gotchas: subshells, `source`/`.` of other scripts (a `source other.sh` could be modeled as a file-level dependency — optional, `TODO(spec-08-followup)`); dynamic command names (drop); aliases.

## Discovery: detection, walker, grammars

- **`detectLanguage`** ([signature-extractor.ts:39](../../src/core/analyzer/signature-extractor.ts#L39)): add `.kts`→Kotlin, `.phtml`→PHP, `.scala`/`.sc`→Scala, `.dart`→Dart, `.lua`→Lua, `.ex`/`.exs`→Elixir, `.sh`/`.bash`→Bash. `.kt`/`.php`/`.cs`/`.c` already map — leave them. Apply the `.h` heuristic. Update the `FileSignatureMap.language` doc comment ([signature-extractor.ts](../../src/core/analyzer/signature-extractor.ts)) which currently enumerates the old language set.
- **File walker** ([src/core/analyzer/file-walker.ts](../../src/core/analyzer/file-walker.ts)) is deny-list based, so these extensions are already walked. Confirm none are excluded; do not remove existing excludes.
- **Grammars** (`package.json`): add the nine grammar packages (or the subset that have stable releases — see degradation). Pin versions consistent with the existing `^0.23.x`/`^0.24.x` range where available. These are **native modules**; the PR body must list each grammar, its install size, and whether it prebuilds or compiles from source (exactly as spec-04 justified `protobufjs` and spec-07 justified `tree-sitter-hcl`).
- **Signatures/search:** the regex-based Stage-1 signature extractors in `signature-extractor.ts` (used for search before/independent of the call graph) currently cover a subset of languages. Extend the signature extraction for the new languages **best-effort** so they are searchable via BM25 (spec-06) even when a grammar fails to load; if full signature regexes per language balloon scope, ship the call-graph extraction (which already feeds search) and leave `TODO(spec-08-followup): Stage-1 regex signatures for <lang>`.

### Graceful degradation (required)

Native grammar modules can fail to install/build on some platforms. Each new language's `getXxxParser()` must fail **soft**: wrap the dynamic import in the same defensive pattern the codebase uses, and if the grammar is unavailable, log one clear warning (`language <X> grammar unavailable — files will be indexed for search but not graphed`) and skip graph extraction for that language **without aborting `analyze` or any other language**. A missing grammar must never throw out of `CallGraphBuilder.build`. Add a test that simulates an unavailable grammar and asserts analyze completes and other languages are unaffected.

## Files you will create or modify (approximate)

```
src/core/analyzer/call-graph.ts             # 9 × {lazy loader, FN_QUERY, CALL_QUERY, dispatch branch};
                                            #   graceful-degradation wrapper; .h C/C++ heuristic
src/core/analyzer/signature-extractor.ts    # detectLanguage extensions; .h heuristic; doc comment;
                                            #   best-effort Stage-1 signatures for new languages
src/core/analyzer/file-walker.ts            # confirm extensions walked (likely no change)
package.json                                # tree-sitter-c-sharp, -kotlin, -php, -c, -scala, -dart,
                                            #   -lua, -elixir, -bash (justify each in PR body)
docs/language-support.md                    # supported languages, per-language extraction limits, .h rule
README.md                                   # "Languages" section: add the nine; note phantom-bug fix
test/  →  co-located *.test.ts + fixtures   # NOTE: top-level test/ is gitignored here. Co-locate tests
                                            #   next to source; put fixtures under
                                            #   src/core/analyzer/fixtures/<lang>/ and EXCLUDE them from
                                            #   tsconfig + eslint (as done for src/core/scip/fixtures and
                                            #   src/core/analyzer/iac/fixtures)
```

## Acceptance criteria

1. **Phantom bug fixed.** On a fixture repo containing C#, Kotlin, PHP, and C files, `openlore analyze` produces non-empty nodes **and** edges for each (today it produces zero). Assert exact node/edge counts against small fixtures. A regression test guards that these four never silently return an empty graph again.
2. **New languages graphed.** For each of Scala, Dart, Lua, Elixir, and Bash, a fixture with two functions where one calls the other yields exactly two `FunctionNode`s and one `CallEdge` with the correct direction (caller → callee). Lock exact counts.
3. **Class/grouping.** For the languages with grouping constructs (C#, Kotlin, PHP, Scala, Dart, Elixir), a fixture with a class/object/module containing two methods yields one `ClassNode` whose `methodIds` reference both method `FunctionNode`s.
4. **Language-specific edges resolve.** Targeted fixtures prove: C# `Class.StaticMethod()` and `this.M()`; Kotlin extension-function call; PHP `$this->m()`, `Class::m()`, free `foo()`; Elixir `Mod.fun()` and local `fun()`; Lua `t:m()` and `t.f()`; Bash defined-function call (and **no** edge to `grep`/`ls`).
5. **`.h` disambiguation.** A C-only project's `.h` → `C`; a project with `.cpp` present → its `.h` stays `C++`. Both assert correctly; no C++ project regresses.
6. **Cross-cutting tools unchanged.** `orient`, `search_code`, `get_subgraph`, `analyze_impact`, and `trace_execution_path` return nodes/edges for every new language with **zero changes** to those tools (assert in an integration test on a polyglot fixture spanning at least three of the new languages). The spec-05 manifest `languages[]` includes the new tags; the spec-04 SCIP export emits the new-language nodes without error (mapping any language with no SCIP `Language` enum value to `UnspecifiedLanguage`, already handled by `scipLanguageName`).
7. **Graceful degradation.** With a grammar made unavailable (simulated), `analyze` completes, emits the documented warning, indexes that language's files for search, and produces full graphs for all other languages.
8. **Determinism.** Re-analyzing an unchanged tree yields an identical graph (stable ids, sorted edges) for every new language.
9. **No regression.** The full existing suite passes; a before/after graph snapshot of the OpenLore repo itself (which is TypeScript) is byte-identical; the existing nine languages' fixtures are unchanged.
10. `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` all pass. The PR body justifies each added native grammar dependency (size, prebuild vs. source compile, platform support) exactly as spec-04 and spec-07 did.

## Detection heuristics — be conservative

- Emit a call edge **only** when the callee resolves to a function declared in the project (matching the existing name-based, confidence-scored approach). Dynamic dispatch, reflection, `eval`, variable/computed method names, macro-generated functions → **no edge**; leave `TODO(spec-08-followup): dynamic call resolution for <lang>`.
- Never invent grouping constructs a language doesn't have (C, Lua, Bash have no classes — do not synthesize them; use file scope).
- Multi-clause / overloaded / partial definitions (Elixir multi-clause, C# partial classes, PHP/whatever overloads) collapse to **one logical node** per name+container, with clause/overload count noted in the signature — never N duplicate nodes for the same logical function.
- When a grammar's export shape or query syntax is uncertain, write a tiny throwaway probe against one fixture to confirm node types **before** writing the full query. Tree-sitter node-type names differ per grammar; guessing them wastes a full debug cycle.

## Out of scope for this PR (deferred languages / non-call-graph)

Ship the nine above in this one PR. Explicitly deferred to future specs — do **not** start them here, but leave `TODO(spec-08-followup): <name>` where a natural extension point exists:

- **Deferred general-purpose** (popular but lower priority / less mature grammar / declining): **Objective-C**, **Perl**, **Haskell**, **Clojure**, **F#**, **Groovy**, **OCaml**, **Zig**, **Nim**, **Julia**, **Erlang**, **Visual Basic / VB.NET**, **PowerShell**, **Fortran**, **COBOL**.
- **Out of scope by design** (not call-graph-shaped — these need a *different* model, not this extractor pattern): **SQL** (query/DDL — a schema-and-reference graph, a separate spec like spec-07's IaC), **R** / **MATLAB** (vectorized interactive analysis, weak intra-project call structure), **HTML/CSS/templating** (not executable control flow), **Markdown/JSON/YAML config** (data, not code — except where spec-07 already claims it as IaC).
- **Assembly**, **WebAssembly text (WAT)**: out of scope.

(You may be tempted to fold one more "easy" language in because the pattern is mechanical. Resist it — nine languages, including four phantom-bug fixes, is a full PR. Adding more raises the native-dependency surface and the regression risk for every existing language without proportional value.)

## Test plan

- **Per-language unit tests**, co-located, small fixtures under `src/core/analyzer/fixtures/<lang>/`. For each language: parse the fixture, assert exact `FunctionNode`s, `ClassNode`s (where applicable), and `CallEdge`s with correct direction. Lock counts once computed (small fixtures, like spec-04/07).
- **Phantom-regression tests** — explicit tests that C#, Kotlin, PHP, and C produce **non-empty** graphs (the precise failure mode this spec fixes).
- **`.h` heuristic test** — table-driven across the three cases.
- **Graceful-degradation test** — simulate an unavailable grammar; assert `analyze` completes and other languages are unaffected.
- **Polyglot integration test** — one fixture mixing app code in ≥3 new languages plus an existing language; assert `orient`/`get_subgraph` surface nodes across all of them and at least one cross-language-irrelevant intra-language edge resolves; proves the projection rides the existing tools unchanged.
- **Determinism test** — build twice per language, deep-equal the serialized graph.
- **No-regression snapshot** — snapshot the OpenLore repo's own graph before and after; assert byte-identical (the repo is TypeScript, so any diff means you perturbed an existing path).
- **Regression** — full existing suite stays green.

## Git workflow — read carefully

1. Branch: `openlore-spec-08-additional-languages` off the default branch.
2. **Open exactly ONE pull request** titled `spec-08: additional general-purpose language support (C#, Kotlin, PHP, C, Scala, Dart, Lua, Elixir, Bash)` for **ALL** of this work — all nine languages, the phantom-bug fix, the `.h` heuristic, graceful degradation, discovery, docs, and tests. **Every commit for this spec — every language, every fix, every follow-up revision, every reviewer-requested change — pushes to that single PR and that single branch. Never open a second PR under any circumstances.** If the design changes mid-flight, push more commits to the same branch. If a reviewer requests changes, push more commits to the same branch. If you split the work across sessions, resume on the same branch and the same PR.
3. Land it incrementally **within that one PR**. A reasonable commit sequence: (a) detection + `.h` heuristic + graceful-degradation scaffold + the shared dispatch plumbing; (b) C#; (c) Kotlin; (d) PHP; (e) C; (f) Scala; (g) Dart; (h) Lua; (i) Elixir; (j) Bash; (k) docs + README + polyglot integration test. Each commit keeps `lint`/`typecheck`/`test:run`/`build` green.
4. Record the architectural decision (additional languages follow the existing tree-sitter extractor pattern; no schema/MCP/tool changes; phantom languages are the priority) via `record_decision` **before** writing code, per the repo's decision-gate workflow.
5. If a single language's edge resolution balloons scope, ship its **nodes** plus the edges you can resolve cleanly and leave precise `TODO(spec-08-followup): …` markers — but still ship all nine languages' detection and node extraction in this PR. Do not split a language across PRs, and do not drop the phantom-bug fix.
6. Run `lint`, `typecheck`, `test:run`, `build` before every push.

## When you are done

Reply with: PR URL, summary, follow-ups, files changed. Nothing else.

---

## Implementation log (2026-05-27)

Status: **complete** — all nine languages shipped on branch
`openlore-spec-08-additional-languages`, one PR.

### Architectural decisions

1. **Followed the existing tree-sitter extractor pattern exactly.** Each new
   language is wired in four places (lazy soft loader, FN/CALL queries, dispatch
   branch, detection). No change to `FunctionNode`/`CallEdge`/`ClassNode`, the
   MCP tools, `orient`, the search index, SCIP export, or the federation
   manifest. Existing extractors were not touched.
2. **Shared query-driven extractor (`extractByQueries`).** The structurally
   similar languages (C#, Kotlin, PHP, C, Scala, Dart, Lua, Bash) run through one
   generic extractor parameterized by a `QueryLangSpec` (queries + grouping node
   types + optional hooks). Elixir gets a bespoke walk because its grammar models
   everything as `call` nodes.
3. **Name-based call resolution.** New languages capture the callee *name* only
   (not the receiver object) and resolve via the existing name-based trie — the
   self/cls/type-inference strategies aren't wired for these languages, so
   capturing the object only forced calls external. This matches the repo's
   "best-effort, name-based" edge policy and resolves `this.M()`/`Class.M()`/
   `$this->m()`/`Obj.m()` cleanly.
4. **Graceful degradation is mandatory and load-bearing here.** Grammars are
   native modules; `loadGrammarSoft` caches per language, warns once, and returns
   null on failure so `analyze` never crashes and other languages are unaffected.

### Phantom-language fix

C#, Kotlin, PHP, and C were detected by `detectLanguage` but had no dispatch
branch → counted-but-empty graphs. They now produce real nodes and edges. The
`.h` ambiguity is resolved by `resolveHeaderLanguage` (tested): C-only project →
C; any C++ source present → C++; standalone → C++.

### Grammar / environment notes (native ABI + WASM backend)

Host `tree-sitter` is pinned at 0.22.4 (ABI 14); node 25 cannot compile
`tree-sitter` 0.25 from source here. Native grammar versions were pinned to
ABI-14 prebuilds where needed: `tree-sitter-c-sharp@0.23.1`,
`tree-sitter-php@0.23.12`, `tree-sitter-c@0.23.6`, `tree-sitter-bash@0.23.3`;
Kotlin/Scala/Elixir load natively at latest (7 languages, native).

**Lua and Dart have no ABI-14-compatible native build**, so rather than ship
them as detection-only, they load a **portable WASM grammar** (`tree-sitter-wasms`)
through **`web-tree-sitter`** (`loadWasmGrammarSoft` → unified `GrammarHandle`).
This makes all nine languages **actually extract**, not just degrade. Notes:
- WASM trees/queries hold WASM-heap memory; `withTree` disposes them per parse
  (`tree.delete()`), or repeated parses corrupt the heap.
- The WASM bytes are read by us and handed to `Language.load(Uint8Array)` so
  web-tree-sitter never does its own `require("fs/promises")` (ESM-unfriendly).
- Dart's grammar puts `function_body` as a *sibling* of `function_signature`,
  so Dart uses a custom walk (spans signature+body) rather than the generic
  query extractor.
- Vitest's module sandbox corrupts the shared WASM heap when two WASM grammars
  run in one test file (production node does not), so the Dart and Lua tests
  live in separate files. If even the WASM backend is unavailable, both still
  degrade gracefully (tested).

### Verified

All ten acceptance criteria addressed: phantom fix, new-language graphs,
class grouping, language-specific edges, `.h` disambiguation, cross-cutting
tools unchanged (polyglot integration test), graceful degradation (simulated
unavailable grammar), determinism (build-twice deep-equal), no regression (full
suite green, existing extractors untouched), and `lint`/`typecheck`/`test:run`/
`build` all pass.

### Follow-ups (`TODO(spec-08-followup)`)

- Bash `source`/`.` as file-level dependency edges.
- Stage-1 regex signatures per new language (call-graph already feeds search).
- Deferred languages (Objective-C, Perl, Haskell, Clojure, F#, Groovy, OCaml,
  Zig, Nim, Julia, Erlang, VB.NET, PowerShell, Fortran, COBOL) remain future
  specs; SQL/R/MATLAB/HTML need a different (non-call-graph) model.
