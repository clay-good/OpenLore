# verifier spec delta

## ADDED Requirements

### Requirement: VerificationReportDisclosesItsDenominator

The verification report SHALL disclose how many candidates were attempted and how many failed
(with per-file failure reasons), and SHALL label aggregate figures (overall confidence, sampled
files) as computed over the successful subset. When failed candidates exceed a disclosed
fraction of the attempted sample, the report's recommendation SHALL be withheld or explicitly
qualified — a readiness verdict SHALL never be presented as if the full sample was checked when
most of it was not.

#### Scenario: Failures shrink the numerator, not the truth

- **GIVEN** 12 verification candidates of which 9 fail (e.g. rate-limited)
- **WHEN** the report is generated
- **THEN** it reports 12 attempted, 9 failed, 3 verified — not "Files Verified: 3" alone
- **AND** the recommendation is withheld or carries an explicit low-coverage qualification

#### Scenario: A clean run is unqualified

- **GIVEN** a run where every candidate verifies without error
- **WHEN** the report is generated
- **THEN** attempted equals verified, failed is zero, and the recommendation carries no
  coverage qualification

#### Scenario: The report timestamp is locale-independent

- **GIVEN** any generated verification report
- **WHEN** its timestamp is written
- **THEN** it is ISO 8601, matching sibling artifacts

### Requirement: RequirementClaimsRequireEvidence

The verifier SHALL NOT synthesize per-requirement implementation membership from a scalar score.
When coverage comes from an LLM-judged score, the report SHALL present that scalar with its
provenance and SHALL NOT name individual requirements as implemented or unimplemented. Named
requirement-level feedback SHALL be emitted only by a path that assessed each named requirement
against the file's content.

#### Scenario: The LLM-scored path names no requirements

- **GIVEN** a file whose requirement coverage comes from an LLM score
- **WHEN** its verification result is reported
- **THEN** the report and interactive output present the coverage score and its LLM provenance
- **AND** no feedback names individual requirements as implemented or unimplemented

#### Scenario: The evidence-bearing path may still name requirements

- **GIVEN** a file assessed by the deterministic keyword-matching fallback
- **WHEN** a requirement's keywords do not appear in the file
- **THEN** that requirement may be named in feedback, because it was individually assessed
