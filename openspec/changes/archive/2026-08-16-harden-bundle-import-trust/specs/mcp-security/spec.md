# mcp-security spec delta

## ADDED Requirements

### Requirement: OptInDetachedBundleSignatureVerification

The bundle codec SHALL support optional, fully local producer authentication: export MAY attach a
plain ed25519 detached signature computed over a domain-separated canonical trust projection that
binds the payload digest, source commit, analyzed tree state, schema, graph attestation, and file
manifest. Import SHALL verify any present signature against a trusted-key list read
from `.openlore/config.json`. Verification uses only the platform crypto library — no key servers,
no network, no new dependency. A valid signature from a trusted key earns the "provenance
verified (signed by <key-id>)" wording; an absent signature degrades to the unsigned provenance
disclosure; a present signature that fails verification SHALL reject the bundle rather than
falling back to unsigned handling. This complements — and does not weaken — the existing
Untrusted Artifact Deserialization Safety requirement (size caps, safe file names, shape
validation), which continues to run first on every bundle.

Authenticated bundles SHALL use a bundle format version that older importers reject rather than
silently ignoring the signature. New importers MAY read legacy unsigned bundles, but SHALL treat
their source-tree state and provenance as unknown/unverified.

#### Scenario: Signed bundle from a trusted producer

- **GIVEN** a bundle exported with `--sign-key` and the corresponding public key listed in the
  importer's `bundle.trustedSigners`
- **WHEN** the bundle is imported
- **THEN** the signature verifies and the output states provenance is verified, naming the key

#### Scenario: A broken or untrusted signature is a rejection, not a downgrade

- **GIVEN** a bundle carrying a signature that does not verify against any trusted key (tampered
  payload, or a signer the operator never trusted)
- **WHEN** it is imported
- **THEN** the import is rejected with a reason naming the signature failure; it is NOT silently
  treated as an unsigned bundle

#### Scenario: No configuration means no behavior change

- **GIVEN** a repository with no `bundle.trustedSigners` configured and an unsigned bundle
- **WHEN** the bundle is imported
- **THEN** the import proceeds exactly as the unsigned path specifies (integrity checks plus the
  provenance-UNVERIFIED disclosure); signature machinery adds no requirement on anyone who has
  not opted in
