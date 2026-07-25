# Tasks — harden call resolution ambiguity

## Implementation
- [x] Add `ambiguous` call-site disposition to `call-graph-types.ts` (candidate list, bounded to a
      fixed cap; count disclosed when truncated)
- [x] `name_only` ambiguity guard: >1 cross-file candidate, no affinity → record ambiguous site, do
      not bind (`call-graph.ts` Strategy 4); unique candidate still binds as `name_only`
- [x] Python `self.`/`cls.` path adopts `resolveSelfMethod`'s affinity ladder (share, don't copy)
- [x] `type_name` strategy binds only a unique type match; else ambiguous site
- [~] Symbol trie arity discriminator; exact-arity bind, ambiguous arity → ambiguous site —
      **DEFERRED to a follow-up.** Overloads collapse at *node identity* (two overloads share the id
      `file::Class.method`, one is dropped before resolution), so the ladder never sees a
      multi-candidate overload set. Splitting overloads into arity-qualified nodes + resolving by
      call-site arg count is a node-identity change (stable ids, CFG side-table, symbol continuity,
      node-count consumers) — a different, larger blast radius, tracked separately. Disclosed in the
      spec delta and the proposal.
- [x] `find_dead_code`: a function reachable only via an ambiguous site's candidate list is reported
      at reduced confidence, never `confident`-dead
- [x] `analyze_error_propagation` / `analyze_impact`: surface ambiguous sites in `boundaries`

## Conformance
- [x] Name-collision fixture per first-match-prone strategy (bare cross-file, self/cls, type_name):
      ambiguous case does NOT bind arbitrarily (overload pair deferred with the arity work)
- [x] Cross-file happy-path fixture for all 18 callGraph languages (was 3) + coverage guard
- [x] Recursion / nested-shadowing regressions stay green (stable-nested-function-identity suite)

## Verification
- [x] Before/after structural diff on this repo: every removed edge has ≥2 candidates;
      confidence distribution shift reported in the PR
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD NoFirstMatchBindingOnAmbiguity (scoped to the three resolution-ladder
      strategies; overload arity disclosed as a follow-up); MODIFY
      CapabilityMatrixIsConformanceVerified (collision + cross-file breadth scenarios)
