# Tasks — resolve-literal-reflective-dispatch

## Implementation

- [ ] Extract the static-literal reader used by `staticChannelKey` (`call-graph.ts:2891`) into a
      shared helper so literal reflection and event synthesis read constants identically
      (string literal · substitution-free template · symbol literal · constant member reference)
- [ ] `literal-reflection` rule module registered with the existing synthesis rule runner
      (`call-graph.ts:3729+`), one rule per family, each independent and failure-isolated:
  - [ ] reflective invoke — Python `getattr(o,"m")(...)`; Ruby `send`/`public_send`/`method(:m)`;
        PHP `call_user_func`/`call_user_func_array` incl. the `[$obj,'m']` array-callable form;
        Java `getMethod("m")`; C# `GetMethod("m")`
  - [ ] computed member with a literal key — `obj["m"]()` (TS/JS, Python subscript-call, Ruby)
  - [ ] dynamic import with a literal specifier — `importlib.import_module("p.m")`,
        `__import__`, `require(lit)`, `import(lit)` → feeds the existing import graph
  - [ ] literal dispatch table — module/class-level literal map of literal keys → named internal
        functions, indexed at a call site; fan-out capped, over-cap dropped whole
  - [ ] container registration ↔ resolution paired on the same literal token in-repo
- [ ] Receiver-type narrowing: when the receiver's type is statically recoverable, resolve within
      that type's subtree via the existing CHA model before name+arity fallback
- [ ] Regex pre-filters per family, in the style of `EVENT_PREFILTER` / `TS_CALLBACK_PREFILTER`,
      so files with no reflective construct are never re-walked
- [ ] Stop pre-dropping the reflective constructs before the rules run: `getattr`/`setattr` stay
      ignored as ordinary calls (`call-graph-builtins.ts:23`) but the rule sees the node;
      `importlib` (`call-graph-external.ts:32`) reaches the rule before collapsing to `external::`
- [ ] Emit every edge with `confidence: 'synthesized'`, `synthesizedBy: 'literal-reflection'`;
      no new confidence tier, no new tuning constant
- [ ] Register the per-language coverage in the language-capability registry (derived from the
      live rule tables, so the matrix cannot over-claim)

## Verification

- [ ] Per-language fixtures: one recovered edge per family per supported language, asserting
      caller, callee, line, confidence, and `synthesizedBy`
- [ ] Refusal fixtures: computed target · ambiguous name · concatenated name · non-literal
      specifier → zero edges, in every family
- [ ] Partition test (shared with `disclose-dynamic-boundary-regions`): every matched construct
      yields exactly one of edge / site — never both, never neither
- [ ] Over-cap dispatch table emits nothing, not a partial wiring
- [ ] `directResolvedOnly` test: a symbol reachable only via a literal-reflection edge is
      unreachable in that mode
- [ ] Additive-only test: rules disabled ⇒ byte-identical graph vs. the pre-change fixture graph
- [ ] Dead-code regression: a plugin reached only by literal container resolution stops being
      reported as a high-confidence dead candidate
- [ ] Determinism: analyze-twice byte-diff e2e unchanged; edge ordering stable
- [ ] Full suite green; docs updated (`reachability-dead-code.md`, `language-support.md`,
      `ALGORITHMS.md`)
