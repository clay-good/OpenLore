# cli spec delta

## ADDED Requirements

### Requirement: EmittedCertificatesAreAttestableOnDemand

When invoked with `--attest`, the certificate-emitting commands (`impact-certificate`,
`certify-public-surface`, `review`) SHALL wrap their unchanged verdict in a signed statement
whose subject binds the content digest of the certified diff and the graph fingerprint it was
computed against, signed with a repo-local key from config. `openlore verify-attestation` SHALL
check signature validity, subject-digest match, and graph-fingerprint match, reporting each
independently. The statement SHALL scope its claim to binding (what was certified, by which
producer, against which graph), never to verdict correctness. Without `--attest`, output SHALL
be byte-identical to the unattested behavior; a missing or invalid key SHALL fail the `--attest`
invocation loudly rather than emit an unsigned artifact.

#### Scenario: A downstream gate verifies without re-analysis

- **GIVEN** an attested impact certificate produced for diff D against graph fingerprint G
- **WHEN** `verify-attestation` runs with the same diff and local index at G
- **THEN** signature, subject-digest, and fingerprint checks each pass, and the output states
  the claim is binding, not correctness

#### Scenario: Tampering is detected, key absence is loud

- **GIVEN** an attested certificate whose embedded verdict was edited after signing, and a
  second invocation of `--attest` with no configured key
- **WHEN** `verify-attestation` runs on the first and the second invocation executes
- **THEN** the first fails the subject-digest check (signature and fingerprint reported
  separately), and the second exits with an error naming the missing key — no unsigned artifact
  is produced
