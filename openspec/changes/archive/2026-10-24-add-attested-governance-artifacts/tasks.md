# Tasks — add-attested-governance-artifacts

## Implementation
- [ ] Attestation module: ITE-6-shaped statement (subject = diff digest + graph fingerprint,
      producer = openlore@version, predicate = the unchanged verdict + a binding-not-correctness
      clause), DSSE ed25519 sign/verify via `node:crypto`; key paths from config
      (`attestation.privateKeyPath`, `attestation.trustedSigners`)
- [ ] `--attest` on `impact-certificate`, `certify-public-surface`, `review`; missing/invalid
      key → loud failure, never an unsigned "attested" artifact
- [ ] `openlore verify-attestation <file> [--diff <ref>]`: signature, subject-digest, and
      graph-fingerprint checks reported separately
- [ ] Decision ledger hash chain: each status transition appends `{prevHash, transition, at}`;
      chain replay helper
- [ ] `verify_claim decision-current`: additive `historyIntact: true|violated|not-chained`
      (pre-change stores report `not-chained`, never a retroactive claim)

## Verification
- [ ] Round-trip: attest → verify passes; tampered verdict byte → subject check fails; wrong
      key → signature check fails; each reported independently
- [ ] Unattested paths byte-identical to today
- [ ] Ledger: legitimate transition chain replays; a hand-edited status flip → `violated`;
      legacy store → `not-chained`
- [ ] Full suite green

## Spec
- [ ] `cli` delta: ADD EmittedCertificatesAreAttestableOnDemand
- [ ] `mcp-security` delta: ADD DecisionHistoryIsTamperEvident
