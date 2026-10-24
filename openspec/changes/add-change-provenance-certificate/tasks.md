# Tasks — add change provenance certificate

> As built: `certify_provenance` composes `change_impact_certificate` (which already folds in
> `blast_radius` → affected/tests, surfaces + newly-opened paths, and spec drift) plus
> `structural_diff`. It is family `change` (a diff tool, like `change_impact_certificate`),
> shipped in the opt-in `verify` preset. `change-provenance.ts`.

## Implementation
- [x] Certificate content: compose `change_impact_certificate` (blast radius, surfaces,
      newly-opened paths, specs, tests, findings, boundaries) + `structural_diff` (added/removed/
      re-signed functions) over a commit range; base via the impact certificate's
      `resolveBaseRefDisclosed`; **fatal on a bad base** (`allowBaseFallback` opt-in)
- [x] Reproducibility: `canonicalJson` (sorted keys) + sha256 content-address digest; identical
      inputs → byte-identical predicate and digest (recompute-to-verify is the trust model)
- [x] Formats: a versioned in-toto predicate (`PROVENANCE_PREDICATE_TYPE`) for attachment to
      existing attestation, and equivalent standalone JSON; **no signing in OpenLore**
- [x] Boundary disclosure: the impact certificate's caveats + dynamic-boundary crossings carry
      through; the claim stays a lower bound, never "safe"
- [x] `certify_provenance` MCP handler + dispatch; `verify` preset; family `change`; class
      `conclusion`; `_RO` annotation with the gated-write (`persist:false`) allowlist entry;
      epistemic-lease weight; sibling cross-reference to `change_impact_certificate`; full-surface
      tool count, payload budget, and standing-context docs updated
- [ ] Fold in `certify_public_surface` (explicit breaking-export verdicts) as a predicate field
- [ ] `openlore certify-provenance [--base <ref>] [--change <id>] [--format in-toto|json] [--out
      <path>]` CLI (today the capability ships as the MCP tool; the CLI is the CI-emission surface)

## Verification
- [x] Reproducibility test: same inputs → same digest; digest changes with the change content
- [x] Canonical JSON is key-order independent and nests
- [x] The predicate carries the semantic record (structural delta, surfaces, specs, tests,
      boundaries) and a disclosed base-ref fallback
- [x] OpenLore emits but does not sign (no crypto introduced beyond sha256 content-addressing)
- [x] tool-registration guards green (contract, annotations incl. read-only write-audit, presets,
      payload budget, doc-claim-sync, tool-count, epistemic-lease, Pi parity, TLS coverage)
- [ ] in-toto predicate schema validation against an external validator (with the CLI surface)

## Spec
- [x] `mcp-handlers` delta: ADD SemanticChangeProvenanceIsReproducibleAndPortable (MCP tool;
      `certify_public_surface` fold-in + the CLI remain, so the change stays open until they land)
- [x] Archived `add-attested-governance-artifacts` as superseded (done in #603)
