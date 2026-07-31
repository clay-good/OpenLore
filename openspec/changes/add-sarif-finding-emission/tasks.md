# Tasks — add-sarif-finding-emission

## Implementation
- [ ] SARIF 2.1.0 serializer: `FINDING_CODE_REGISTRY` → `tool.driver.rules` (id, description,
      helpUri); findings → `results` (message verbatim, resolved enforcement class as a result
      property); subject → `physicalLocation` from stored spans, logical-location fallback for
      unresolvable subjects (never a fabricated line); fixed severity→level table; one `run`
      stamped with tool version + graph fingerprint
- [ ] `--sarif <path>` on `openlore enforce` and `openlore review`; existing outputs and exit
      codes byte-identical
- [ ] Stable ordering; no wall-clock content (determinism: same findings + graph ⇒ byte-
      identical file)

## Verification
- [ ] Golden-file test validated against the SARIF JSON schema
- [ ] Every registry code appears as a rule; a finding with an unresolvable subject carries a
      logical location only
- [ ] Byte-identical emission on repeated runs at fixed state
- [ ] Exit codes and existing outputs unchanged with and without `--sarif`
- [ ] Full suite green

## Spec
- [ ] `cli` delta: ADD FindingsAreEmittableAsSarifTransport
