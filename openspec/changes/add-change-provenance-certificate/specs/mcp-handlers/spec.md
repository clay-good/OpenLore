# mcp-handlers spec delta

## ADDED Requirements

### Requirement: SemanticChangeProvenanceIsReproducibleAndPortable

The system SHALL provide an opt-in `certify_provenance` conclusion and `openlore certify-provenance`
CLI that emit a semantic change certificate for a commit range against a base resolved through
`resolveBaseRefDisclosed`. The certificate SHALL record what the change does — the structural delta,
blast radius, public-surface verdict, specs touched and any drift, the tests reaching the change,
and declared-footprint escapes — each as evidence carrying its rule. The certificate SHALL be
reproducible (same inputs produce a byte-identical document) and content-addressed by a digest, so
that any consumer can recompute it and verify it rather than trusting its source. It SHALL be
emittable as an in-toto predicate with a stable, versioned `predicateType` for attachment to the
repository's existing identity/build attestation, and equivalently as standalone JSON; OpenLore
SHALL emit the document and SHALL NOT perform signing. The certificate SHALL disclose its boundaries
(unresolved dynamic dispatch, unindexed languages, a stale index) and present its claims as a sound
lower bound, never as "safe"; a bad base SHALL be fatal. It SHALL cross-reference
`change_impact_certificate` as its sibling — that tool briefs the author's pending diff in-session,
this emits a portable, recomputable attestation a third party can verify.

#### Scenario: A consumer recomputes and verifies the certificate

- **GIVEN** a certificate emitted for a commit range and its recorded digest
- **WHEN** a consumer runs `certify-provenance` over the same range and base
- **THEN** the document is byte-identical and the digest matches, so the certificate is verified
  without trusting who produced it

#### Scenario: It attaches to existing attestation without replacing it

- **WHEN** the certificate is emitted with `--format in-toto`
- **THEN** it is a predicate with a stable versioned `predicateType` that attaches to the repo's
  SLSA/in-toto attestation, and OpenLore performs no signing of its own

#### Scenario: Boundaries make the claim a lower bound

- **GIVEN** a change that touches an unindexed language or crosses an unresolved dynamic-dispatch
  boundary
- **WHEN** the certificate is computed
- **THEN** the affected scope is disclosed as not-assessed and the overall claim reads "no detected
  surface break", never "safe"

#### Scenario: A bad base is fatal

- **GIVEN** a base ref that cannot be resolved
- **WHEN** the certificate is requested
- **THEN** emission fails with the disclosed reason rather than certifying against a substituted base
