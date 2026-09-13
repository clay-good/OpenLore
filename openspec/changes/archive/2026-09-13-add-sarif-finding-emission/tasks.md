# Tasks — add-sarif-finding-emission (narrowed)

## Implementation
- [x] SARIF 2.1.0 serializer (`src/core/services/sarif.ts`): registry → sorted rules (description,
      source, default class); classified findings → sorted results (message verbatim, fixed
      severity→level table, enforcement class and subject as properties, identity hash in
      `partialFingerprints`); recorded repository-relative location → physical location (line only
      when recorded), otherwise a logical location; run stamped with version + graph fingerprint
- [x] `--sarif <path>` on `openlore enforce` (not combinable with `--agent-hook`) and `openlore review`;
      printed output and exit codes unchanged; a write failure only warns
- [x] Stable ordering; no wall-clock content

## Verification
- [x] Structural checks of the SARIF 2.1.0 shape (schema URI, version, driver, rules, results)
- [x] Every registry code appears as a rule; a finding without a usable location carries a logical
      location only
- [x] Byte-identical emission for reordered input
- [x] Exit code and stdout unchanged with and without `--sarif` (enforce)
- [x] Full suite green

## Narrowed
- Locations come from each finding's recorded `location`; no symbol-span lookup from the graph.
- No `helpUri` per rule and no vendored JSON-schema validation (no schema validator dependency).
