# Tasks — add-effect-purity-inference

## Implementation
- [ ] Direct-effect extraction in Pass 1 (TS/JS/Python): non-local assignment → module-state,
      param member-write → mutates-params, closed I/O pattern table → io; other languages emit
      no fact
- [ ] Transitive effect closure at analyze over resolved edges (join semantics; unresolved /
      external / dynamic-boundary callee ⇒ unknown), riding the reachability precompute;
      incremental recompute keyed by content hash on the watcher path
- [ ] Surface `effects` on orient relevant-functions, `get_function_skeleton`, `blast_radius`
- [ ] `verify_claim` kind `effect-free`: confirmed (proven pure) / refuted (effect path
      receipt) / unverifiable (blocking boundary named)
- [ ] Register `pure-annotation-contradicted` advisory finding: annotated target with a proven
      non-pure closure effect; receipt = the effect path

## Verification
- [ ] Fixtures per class: module-state write, param mutation, fs/network/console call,
      transitive inheritance through a resolved chain, unknown via external callee, unknown
      via dynamic boundary
- [ ] `pure` is never emitted across an unresolved edge (adversarial fixture)
- [ ] Finding fires only with a proven effect path; annotation absent → no finding
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD EffectFactsAreCompositionalAndSound
- [ ] `mcp-handlers` delta: ADD EffectClaimsCarryReceiptsAndBoundaries
