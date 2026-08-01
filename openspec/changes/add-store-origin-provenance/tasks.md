# Tasks — add store origin provenance

## Implementation
- [ ] Closed origin set on `AnchoredMemory` and decision records: `human-approved |
      agent-recorded | imported-bundle | federated-remote`; immutable after write; legacy
      records read as `agent-recorded (assumed)` — additive schema, no migration
- [ ] Stamp at every writer: `remember`/`record_decision` (agent-recorded), team-memory
      promote + human approve paths (human-approved), bundle import (imported-bundle),
      federation ingest (federated-remote)
- [ ] Disclose origin in `recall`, `verify_claim decision-current`, gate output, injected
      briefings
- [ ] Quarantine: imported/federated memories served advisory-only until anchors (and claims,
      when present) re-verify against the local graph, or a human promotes them; exit is
      automatic and disclosed
- [ ] Register `untrusted-origin-influence` in `FINDING_CODE_REGISTRY` (default advisory);
      emit when a gated conclusion was informed by a non-human-approved fact

## Verification
- [ ] Origin survives store round-trips and cannot be mutated by any update path
- [ ] Legacy `notes.json` loads; records disclose `agent-recorded (assumed)`
- [ ] Imported bundle memory: served advisory with origin disclosed; after local re-verification
      it exits quarantine with the exit reason disclosed
- [ ] Gate informed by an imported decision → finding fires; policy `off | advisory | blocking`
      classes all respected
- [ ] No fifth origin can be written (closed-set enforcement test)

## Spec
- [ ] `mcp-handlers` delta: ADD AnchoredFactsCarryImmutableOrigin
