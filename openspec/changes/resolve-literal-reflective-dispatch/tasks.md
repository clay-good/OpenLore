# Tasks — resolve-literal-reflective-dispatch

> Re-scoped after adversarial review: the by-name families (`getattr("m")`, `send(:m)`,
> `call_user_func('f')`) are OUT — measured, they refuse ~everything under an honest rule and
> emit false edges under a relaxed one. Gated on `shrink-receiver-resolution-boundary`.

## Implementation

- [x] Per-language static-literal reader (reads a literal only from a pure wrapper node, so
      `"get_" + name` yields no partial name). NOTE: `staticChannelKey` (`call-graph.ts:2893`) handles
      **JS/TS node types only** — Ruby symbol literals and Python/PHP string nodes are a
      per-language addition, not an extraction of existing code
- [x] Strict-uniqueness resolver as a **distinct entry point** — exactly one internal candidate
      after narrowing, **no same-file preference**. Do NOT reuse `HandlerResolver`
      (`call-graph.ts:4581-4592`): its `if (inFile) return inFile;` returns a same-file match
      regardless of repo-wide ambiguity
- [x] Three rules, added to the synthesis rule array (`call-graph.ts:3951-3956` — a hardcoded
      list, not a plug-in registry; adding a rule means editing it):
  - [x] literal dispatch table (values are name-bound references resolved in the table's scope)
  - [ ] ~~container registration ↔ resolution on a shared literal token~~ — re-scoped out (see proposal)
  - [x] literal-keyed member access on a statically-typed receiver
- [x] Sequencing: the rules need the class model for receiver narrowing, built at Pass 7
      (`call-graph.ts:4814-4820`) while synthesis runs at Pass 2d (`:4577`). Either run these
      rules after Pass 7 or thread the class/inheritance model into the synthesis entry point —
      and declare the dependency on `shrink-receiver-resolution-boundary`
- [x] Call-form gate: emit only on immediate invocation; a bare `getattr`/`method(:m)`/
      un-invoked array callable/`setattr` produces no edge
- [x] Dedup on `(callerId, calleeId)` against the full accumulated edge set; extend the CHA
      exclusion set (`call-graph.ts:4832-4841`, which currently skips synthesized edges and runs
      after synthesis) so one dispatch is not emitted twice under two labels
- [x] Candidate→site discharge shared with `disclose-dynamic-boundary-regions`, keyed on the
      construct's file and offset: a candidate that bound no edge emits a site with the shipped
      vocabulary (`no-static-target` / `unresolved-external` / `ambiguous-target` / …) plus `over-cap`,
      `unresolved-in-type`, `unattributed-caller`, **after** resolution
- [x] A subset rebuild (`resolutionNodes` supplied) binds nothing and discloses every candidate
- [ ] ~~Construct-anchored pre-filters~~ — not needed: recovery reads the candidates the Pass-1 matcher
      already records, so there is no second parse to pre-filter. Original task: (e.g. the table/registration shape), NOT bare `require(` /
      `.send(` / `get(` — those select nearly every file and the pass re-parses each match
- [x] `language-support.ts`: closed `CAPABILITIES` union entry + description +
      `deriveCapabilities` line sourced from the live rule table + the drift test + a
      behavioral-faithfulness test; update `docs/language-support.md` (CODEBASE.md is generated and already lacked the
      `dynamicBoundary` column; it refreshes on the next `analyze`)
- [x] Do **NOT** modify `call-graph-builtins.ts` or `call-graph-external.ts`: the synthesis pass
      re-parses each file (`call-graph.ts:3540`) and is not subject to the Pass-1 ignore tables

## Verification

- [x] Per-family recovery fixtures asserting caller, callee, line, confidence, `synthesizedBy`
- [x] Strict-uniqueness test: a same-file homonym coexisting with other internal homonyms is
      REFUSED (the case today's handler resolver would wrongly bind)
- [x] Review-driven guards, each with a fixture: table stability decided by use (alias, argument,
      export, shadowing, `Reflect.set`), import-bound entries refused, Python dicts not tables,
      instance context only (static, nested `function`, object literal, Ruby singleton /
      `class << self` / `instance_eval`, Python staticmethod/classmethod), duplicate class names,
      multiple parents, ancestor-plus-override refusal, retention budget and exact totals,
      strict-mode dead-code qualification
- [x] Refusal fixtures, one per reason, each asserting exactly one site and zero edges
- [x] Partition totality test (shared with the sibling): every recognized construct yields
      exactly one of edge / site — never both, never neither; includes the literal-but-external
      case and the over-cap case
- [x] Dedup test: a call both CHA and this change would wire yields exactly one edge
- [x] Incremental-stability test: a subset rebuild binds nothing and discloses every candidate;
      the full build is file-order independent
- [x] `directResolvedOnly` test; additive-only test (rules disabled ⇒ byte-identical graph)
- [ ] ~~Pre-filter cost test~~ — no second parse exists (see above); the extra table walk runs only
      for a file whose subscript call names a module-level `const` table
- [x] Determinism: analyze-twice byte-diff e2e unchanged
- [x] Full suite green; docs updated
