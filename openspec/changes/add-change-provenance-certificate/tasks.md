# Tasks — add change provenance certificate

## Implementation
- [ ] Certificate content: compose `structural_diff`, `blast_radius`, `certify_public_surface`,
      specs-touched + `check_spec_drift`, `select_tests`, and declared-footprint escapes over a
      commit range; base via `resolveBaseRefDisclosed`, fatal on a bad base
- [ ] Reproducibility: byte-identical document for identical inputs (reuse the seeded-determinism
      discipline); emit a content-address digest; recompute-to-verify is the trust model
- [ ] Formats: a versioned in-toto predicate (`predicateType`) for attachment to existing
      attestation, and an equivalent standalone JSON; no signing in OpenLore
- [ ] Boundary disclosure: dynamic dispatch, unindexed languages, stale index → not-assessed in
      the certificate; overall claim is a lower bound ("no detected surface break")
- [ ] `certify_provenance` MCP handler (`verify` preset; family `verify`; class `conclusion`;
      sibling cross-reference to `change_impact_certificate`) + `openlore certify-provenance
      [--base <ref>] [--format in-toto|json] [--out <path>]`

## Verification
- [ ] Recompute test: emit, then re-emit over the same range/base → byte-identical, digest matches
- [ ] A change that opens a new path into a covered surface appears in the certificate with its rule
- [ ] in-toto output validates as a predicate with the stable `predicateType`; JSON output carries
      the same content
- [ ] Unindexed-language / dynamic-dispatch scope disclosed not-assessed; claim never reads "safe"
- [ ] Unresolvable base → fatal, no substituted-base certificate
- [ ] OpenLore emits but does not sign (no crypto introduced)
- [ ] tools/list payload budget re-asserted or bumped with rationale

## Spec
- [ ] `mcp-handlers` delta: ADD SemanticChangeProvenanceIsReproducibleAndPortable
- [ ] Archive `add-attested-governance-artifacts` as superseded by this change
