# Literal reflective dispatch: recover the decidable half of "reflection" instead of dropping it

> Status: PROPOSED (2026-07-25, known-limitations closure #2 of 6). A large share of real
> reflective calls name their target with a **string or symbol literal** —
> `getattr(handler, "process")()`, `obj.send(:refresh)`, `call_user_func('App\\handle')`,
> `importlib.import_module("app.jobs")`, `container.get(UserService)`. Those are statically
> decidable by simple constant reading, and the field has resolved them this way since the
> first Java reflection analyses. OpenLore resolves none of them: the constructs are dropped
> as builtins or flattened into an `external::` edge. This change reads the literal and emits
> a real, provenance-labeled call edge — `confidence: 'synthesized'`,
> `synthesizedBy: 'literal-reflection'` — reusing the resolver the graph already has. Its
> sibling `disclose-dynamic-boundary-regions` owns the non-literal residue; together they
> partition the same matched constructs.

## The gap

- **The literals are thrown away at extraction time.** Python's `getattr` / `setattr` /
  `hasattr` are in `PYTHON_IGNORED` (`src/core/analyzer/call-graph-builtins.ts:23`) and never
  reach resolution; `importlib` and `inspect` are in the external-module set
  (`call-graph-external.ts:32`) and collapse to `external::`, discarding the module name they
  were handed. Ruby `send` / `public_send`, PHP `call_user_func` / `call_user_func_array`,
  Java `Class.forName(...).getMethod("literal")`, and C# `Type.GetMethod("literal")` have no
  handling at all. In each case the target is sitting in the AST as a constant.
- **The machinery to finish the job already exists.** The dynamic-dispatch synthesis pass
  (`call-graph.ts:2819+`) already does exactly this shape of work for event channels: it reads a
  **static channel key** — string literal, substitution-free template literal, or a constant
  member reference — via `staticChannelKey` (`call-graph.ts:2891`), refuses to guess on a
  computed key, resolves handlers through a `HandlerResolver` that returns `undefined` when the
  name is unknown or ambiguous, caps per-site fan-out, and stamps every emitted edge
  `confidence: 'synthesized'` with a `synthesizedBy` rule name. Literal reflection is the same
  pattern pointed at a different construct: **no new algorithm, no new confidence tier, no new
  tuning constant.**
- **The cost of the omission is concentrated in the worst place.** Reflective invocation is how
  plugin systems, job runners, command dispatchers, serializers, and DI containers reach their
  targets — the code most likely to look orphaned, and therefore most likely to be reported as a
  dead-code candidate, an untested `also-dead` gap, or a symbol with an empty blast radius.
- **Prior art is settled and narrow.** Reflection analysis for Java has resolved string-constant
  targets since SOOT/WALA/DOOP; the survey "Understanding and Analyzing Java Reflection"
  (arXiv 1706.04567) records that constant-string resolution is the mainstream technique and
  that its limits begin exactly where the constant ends. The ICSE'20 recall study
  (https://dl.acm.org/doi/10.1145/3377811.3380441) shows the recall this recovers is not
  marginal. We adopt the decidable core and stop precisely where the literature says precision
  collapses — no string solving, no points-to, no partial-evaluation of concatenated names.

## What changes

**1. A literal-reflection rule set, in the existing synthesis pass.** Each rule reads one
construct family, extracts a **static literal target**, resolves it through the existing
name/import resolver, and emits at most one edge per call site:

| Family | Recovered form | Edge target |
|---|---|---|
| Reflective invoke | Python `getattr(o, "m")(...)`; Ruby `send`/`public_send`/`method(:m)`; PHP `call_user_func('f')` / `[$obj, 'm']`; Java `getMethod("m")`; C# `GetMethod("m")` | the named method, resolved within the receiver's type subtree when the type is statically known (reusing CHA), else by name+arity |
| Computed member with a literal key | `obj["method"]()`, `handlers["create"]()` where the key is a literal | the named member |
| Dynamic import with a literal specifier | `importlib.import_module("pkg.mod")`, `__import__("pkg.mod")`, `require("./mod")`, `import("./mod")` | a module-level import edge into the resolved file, feeding the existing import graph |
| Literal dispatch table | a module- or class-level object/dict/hash literal mapping literal keys → named internal functions, indexed at a call site (`TABLE[k]()`) | every named function in the table (fan-out capped, over-cap sites dropped, never partially wired) |
| Container registration with a literal token | `container.register('userService', UserService)` paired with `container.get('userService')` — literal token on **both** sides, same repository | the registered symbol |

**2. Resolution discipline, inherited verbatim from the event rule.** A target that does not
resolve to exactly one internal symbol — unknown name, ambiguous across files, computed
argument, concatenated string, non-literal variable — emits **nothing**, and the construct falls
through to a dynamic-boundary site (the sibling change). Per-site fan-out is capped and over-cap
sites are dropped whole, never partially wired. Every emitted edge carries
`confidence: 'synthesized'` and `synthesizedBy: 'literal-reflection'`, so it is (a) never mixed
with directly-resolved edges, (b) excluded wherever synthesized edges are already excluded, and
(c) removable with the existing `directResolvedOnly` switch.

**3. The partition is enforced, not assumed.** Every construct the shared matcher recognizes
produces exactly one of: a resolved edge (here) or a dynamic-boundary site (sibling). A test
asserts the partition over a fixture covering both halves of each family, so recall improvements
can never silently erase a disclosure.

**4. Language scope is declared, not implied.** Initial coverage: Python, Ruby, PHP,
TypeScript/JavaScript, Java, C#. Every other language records no rules and is reported as
unsupported by `get_language_support` — a quiet result stays interpretable as "unsupported here,"
never as "no reflection here."

**Explicitly NOT built:** string solving or constant propagation across variables and function
boundaries; concatenated / formatted target names; `eval`-constructed code; framework-specific
convention magic (Rails `method_missing` routing, Django's string-based view resolution beyond a
literal import); anything requiring a runtime trace. These stay disclosed boundaries — that is
the sibling change's job, and it is the honest ceiling of this technique.

## Why this is in scope

Call-graph recall is the substrate every conclusion inherits. This closes the *decidable* part
of the README's broadest limitation using a pattern already shipped in-tree, with the same
provenance labeling, the same refusal-to-guess discipline, and the same false-negative bias — and
it makes the honest disclosure that remains genuinely narrow instead of a catch-all. It is
strictly additive: with the rules disabled, the graph is byte-identical to today's.

## Impact

- **Files:** a `literal-reflection` rule module registered with the existing synthesis pass
  (`call-graph.ts:3729+` rule runner), reuse of `staticChannelKey`-style literal reading, the
  `HandlerResolver`, and the CHA type-subtree narrowing; `call-graph-builtins.ts` (stop dropping
  the reflective builtins *before* the rule sees them — they remain ignored as plain calls);
  `call-graph-external.ts` (let `importlib` reach the rule before collapsing to `external::`);
  `docs/reachability-dead-code.md`, `docs/language-support.md`, `docs/ALGORITHMS.md`.
- **Specs:** `analyzer` — 2 ADDED (LiteralReflectiveTargetsResolveToProvenanceLabeledEdges,
  ReflectionRulesRefuseToGuessAndPartitionWithDisclosure).
- **Tool surface:** unchanged. Downstream tools see more synthesized edges through the paths
  that already handle synthesized edges.
- **Performance:** rules run inside the existing synthesis pass, gated by regex pre-filters in
  the same style as the event/callback pre-filters, so files with no reflective construct are not
  re-walked.
- **Risk:** (a) *false edges from a coincidental name match* — mitigated by requiring a unique
  internal resolution, preferring the receiver's type subtree, capping fan-out, and marking every
  edge synthesized (so `directResolvedOnly` and every synthesized-edge exclusion still work).
  (b) *recall silently eating disclosure* — mitigated by the enforced partition test. (c) *rule
  sprawl toward framework magic* — mitigated by the spec's "static literal only" clause; anything
  needing inference is a new proposal.
