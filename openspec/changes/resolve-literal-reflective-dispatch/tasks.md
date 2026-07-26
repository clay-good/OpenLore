# Tasks — resolve-literal-reflective-dispatch

> Re-scoped after adversarial review: the by-name families (`getattr("m")`, `send(:m)`,
> `call_user_func('f')`) are OUT — measured, they refuse ~everything under an honest rule and
> emit false edges under a relaxed one. Gated on `shrink-receiver-resolution-boundary`.

## Implementation

- [ ] Per-language static-literal reader. NOTE: `staticChannelKey` (`call-graph.ts:2893`) handles
      **JS/TS node types only** — Ruby symbol literals and Python/PHP string nodes are a
      per-language addition, not an extraction of existing code
- [ ] Strict-uniqueness resolver as a **distinct entry point** — exactly one internal candidate
      after narrowing, **no same-file preference**. Do NOT reuse `HandlerResolver`
      (`call-graph.ts:4581-4592`): its `if (inFile) return inFile;` returns a same-file match
      regardless of repo-wide ambiguity
- [ ] Three rules, added to the synthesis rule array (`call-graph.ts:3951-3956` — a hardcoded
      list, not a plug-in registry; adding a rule means editing it):
  - [ ] literal dispatch table (values are name-bound references resolved in the table's scope)
  - [ ] container registration ↔ resolution on a shared literal token
  - [ ] literal-keyed member access on a statically-typed receiver
- [ ] Sequencing: the rules need the class model for receiver narrowing, built at Pass 7
      (`call-graph.ts:4814-4820`) while synthesis runs at Pass 2d (`:4577`). Either run these
      rules after Pass 7 or thread the class/inheritance model into the synthesis entry point —
      and declare the dependency on `shrink-receiver-resolution-boundary`
- [ ] Call-form gate: emit only on immediate invocation; a bare `getattr`/`method(:m)`/
      un-invoked array callable/`setattr` produces no edge
- [ ] Dedup on `(callerId, calleeId)` against the full accumulated edge set; extend the CHA
      exclusion set (`call-graph.ts:4832-4841`, which currently skips synthesized edges and runs
      after synthesis) so one dispatch is not emitted twice under two labels
- [ ] Candidate→site discharge shared with `disclose-dynamic-boundary-regions`: a candidate that
      produced no edge emits a site with reason `non-literal` / `unresolved-external` /
      `ambiguous` / `over-cap`, **after** resolution
- [ ] Container pairing computes over the full file set, or is omitted on a subset rebuild with
      its sites disclosed (synthesis iterates only the files it is handed, so a registration in
      an unchanged file is otherwise invisible)
- [ ] Construct-anchored pre-filters (e.g. the table/registration shape), NOT bare `require(` /
      `.send(` / `get(` — those select nearly every file and the pass re-parses each match
- [ ] `language-support.ts`: closed `CAPABILITIES` union entry + description +
      `deriveCapabilities` line sourced from the live rule table + the drift test + a
      behavioral-faithfulness test; update `docs/language-support.md` and CODEBASE.md's matrix
- [ ] Do **NOT** modify `call-graph-builtins.ts` or `call-graph-external.ts`: the synthesis pass
      re-parses each file (`call-graph.ts:3540`) and is not subject to the Pass-1 ignore tables

## Verification

- [ ] Per-family recovery fixtures asserting caller, callee, line, confidence, `synthesizedBy`
- [ ] Strict-uniqueness test: a same-file homonym coexisting with other internal homonyms is
      REFUSED (the case today's handler resolver would wrongly bind)
- [ ] Refusal fixtures, one per reason, each asserting exactly one site and zero edges
- [ ] Partition totality test (shared with the sibling): every recognized construct yields
      exactly one of edge / site — never both, never neither; includes the literal-but-external
      case and the over-cap case
- [ ] Dedup test: a call both CHA and this change would wire yields exactly one edge
- [ ] Incremental-stability test: full analyze vs. subset rebuild reaching the same tree state
      produce identical synthesized edge sets (or the site is disclosed)
- [ ] `directResolvedOnly` test; additive-only test (rules disabled ⇒ byte-identical graph)
- [ ] Pre-filter cost test: report the measured second-parse file count on the self-index; a
      family whose filter selects more than the declared fraction fails
- [ ] Determinism: analyze-twice byte-diff e2e unchanged
- [ ] Full suite green; docs updated
