# mcp-handlers spec delta

## ADDED Requirements

### Requirement: SemanticChangeProvenanceIsReproducibleAndPortable

The system SHALL provide an opt-in `certify_provenance` conclusion tool that emits a semantic change
certificate for the working tree against a base resolved through `resolveBaseRefDisclosed`. The
certificate SHALL record what the change does: the structural delta as counts, the blast radius, the
specs touched and any drift, and the tests reaching the change. The certificate SHALL be
reproducible (same inputs produce a byte-identical document) and content-addressed by a digest of
its predicate body, so that any consumer can recompute it and verify it rather than trusting its
source. It SHALL be emittable as an in-toto statement with a stable, versioned `predicateType`
(input `format: "in-toto"`), and equivalently as standalone JSON; OpenLore SHALL emit the document
and SHALL NOT perform signing. The certificate SHALL disclose unresolved dynamic dispatch and
present its claims as a sound lower bound, never as "safe"; a base that cannot be resolved SHALL be
an error unless the caller opts in to a disclosed fallback. It SHALL cross-reference
`change_impact_certificate` as its sibling — that tool briefs the author's pending diff in-session,
this emits a portable, recomputable record a third party can verify.

#### Scenario: A consumer recomputes and verifies the certificate

- **GIVEN** a certificate emitted for a working tree and base, and its recorded digest
- **WHEN** a consumer calls `certify_provenance` over the same tree and base
- **THEN** the document is byte-identical and the digest matches, so the certificate is verified
  without trusting who produced it

#### Scenario: It attaches to existing attestation without replacing it

- **WHEN** the certificate is requested with `format: "in-toto"`
- **THEN** it is a statement with a stable versioned `predicateType`, and OpenLore performs no
  signing of its own

#### Scenario: A bad base is an error

- **GIVEN** a base ref that cannot be resolved and no opt-in fallback
- **WHEN** the certificate is requested
- **THEN** the tool returns an error with the reason rather than certifying against a substituted
  base
