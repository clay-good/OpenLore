# Tasks — harden-bundle-import-trust

## Implementation
- [x] Wording: import success line for an unsigned bundle says "integrity-consistent; provenance
      UNVERIFIED — trust the source" and never "verified" (import.ts:303, and the
      `commit-matches-head` detail string at import.ts:100); correct the docstring's
      "NEVER serves a ... tampered bundle as current" overclaim (import.ts:5-6)
- [x] Manifest: optional Ed25519 signature over a domain-separated canonical trust projection +
      analyzed `sourceTreeState`; authenticated exports use bundle format v2 so older readers fail
      closed instead of ignoring the signature
- [x] `openlore export bundle --sign-key <path>`: sign with node:crypto ed25519 (no new dependency)
- [x] Import verification: read `bundle.trustedSigners` from .openlore/config.json; trusted+valid
      signature → "provenance verified (signed by <key-id>)"; present-but-invalid signature →
      reject (unreadable-class failure); absent signature → honest unsigned wording
- [x] Analysis records `sourceTreeState` via `git status --porcelain`; bundle export carries the
      analyzed state rather than measuring an unrelated later export-time tree
- [x] Currency: a dirty or legacy-unknown bundle never takes the `commit-matches-head` branch
      (import.ts:99-100) — downgrade to "approximately current, built from a dirty tree at <sha>"
- [x] Generation-committed promote: stage every file on the destination filesystem, hold the
      analysis lock, mark the generation unavailable, atomically rename files, and publish the
      new generation manifest last; no whole-directory rename
- [x] Cross-reference: note in add-incremental-bundle-delta that its apply path inherits the
      provenance wording + atomic promote (no edit to that change dir; note lives here)

## Verification
- [x] Poisoned-bundle e2e: hand-crafted bundle with fabricated nodes + victim-HEAD sourceCommit
      imports WITHOUT the word "verified" anywhere in output; signed variant against an untrusted
      key is rejected
- [x] Signature round-trip: export --sign-key → verify with the pubkey in trustedSigners →
      "provenance verified"; tampered payload after signing → reject
- [x] Fault-prefix promotion test: interruption after replacement begins leaves the generation
      explicitly unavailable, never accepted as a coherent mixed generation
- [x] Dirty-tree test: bundle exported with uncommitted edits at HEAD, imported on a clean
      checkout at that HEAD → "approximately current ... dirty tree", never "verified current"
- [x] Retained guards still pass: zip-slip (isSafeBundleFileName), gunzip cap, manifest/payload
      reconciliation tests unchanged and green
- [x] Full suite green (`vitest run src examples`)

## Spec
- [x] `analyzer` delta: ADD BundleProvenanceIsDisclosedNotImplied, GenerationCommittedIndexPromotion,
      DirtyTreeBundlesNeverClaimCommitCurrency
- [x] `mcp-security` delta: ADD OptInDetachedBundleSignatureVerification
