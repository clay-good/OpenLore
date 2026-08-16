# Harden bundle import trust: integrity is not authenticity, and "verified current" must be earned

> Status: PROPOSED (2026-07-03, e2e audit pass 3). The `.olbundle` import ladder proves a bundle
> is internally self-consistent, then announces "verified current" — but nothing binds the bundle
> to a trusted producer, so a fabricated bundle passes every check and poisons the graph facts
> every navigation tool serves as truth. Separately, the promote step can half-clobber the live
> index on a crash, and a dirty-tree export claims commit-currency it does not have. Fix the
> wording now, add opt-in local signature verification, make promotion generation-committed, and
> disclose dirty trees.

## The gap

- **Integrity conflated with authenticity.** Every rung of the validation ladder is
  self-referential: the payload digest is recomputed from the bundle's own bytes
  (`index-bundle.ts:134-142`, checked at `:316-322`), and the graph-content digest is compared to
  an attestation the *exporter* computed from the same store (`attestExportedStore`,
  `index-bundle.ts:145-164`; checked at `import.ts:247-260`). There is no signature or MAC
  anywhere. A hand-crafted bundle with fabricated nodes/edges and a `sourceCommit` set to the
  victim's HEAD passes all five rungs, and import prints `Imported graph bundle — verified current
  at commit <sha>` (`import.ts:303`) — after which `orient`/`blast_radius`/`structural_diff` serve
  the poisoned graph as ground truth. The module docstring's "NEVER serves a stale,
  schema-mismatched, or tampered bundle as current" (`import.ts:5-6`) overstates what the ladder
  proves: it detects *accidental* corruption, not a hostile producer.
- **Non-atomic promote.** `promoteStagedIndex` (`index-bundle.ts:354-369`) first `rm`'s the live
  WAL sidecars and rebuildable search-index subdirs, then `copyFile`'s each bundled file one at a
  time into the live analysis dir. A crash or SIGINT mid-loop leaves a half-clobbered live index —
  exactly the state the staging comment says cannot happen (`import.ts:236-239`; staging protects
  against a bundle that *fails validation*, not against dying during promotion itself).
- **Dirty-tree export claims commit-currency.** `readSourceCommit` (`index-bundle.ts:119-127`,
  called at `:187`) takes HEAD from `fingerprint.json` with no clean-tree check. A bundle built
  from uncommitted edits records `sourceCommit = HEAD`; a teammate on a clean checkout at that
  HEAD hits the `commit-matches-head` branch (`import.ts:99-100`) and is told "verified current"
  (`import.ts:303`) for a graph encoding phantom symbols no commit contains.

## What changes

1. **Honest wording, unconditionally.** An unsigned import never says "verified". The success line
   becomes: integrity-consistent, currency vs commit `<sha>` — **provenance UNVERIFIED; trust the
   source of this bundle**. The `import.ts:5-6` docstring is corrected to claim tamper-*evidence*
   for accidental corruption plus provenance disclosure, not tamper-proofness.
2. **Opt-in detached signature verification.** `openlore export bundle --sign-key <path>` writes a
   plain ed25519 detached signature over a domain-separated canonical trust projection into the
   manifest. The projection binds the payload digest, source commit, analyzed tree state, schema,
   graph attestation, and file manifest, so metadata cannot be rewritten under a valid signature (Node
   `node:crypto` ed25519 — no new dependency, no key server, fully local). Import reads a
   trusted-key list from `.openlore/config.json` (`bundle.trustedSigners`: public keys); a bundle
   whose signature verifies against a trusted key earns the stronger "provenance verified
   (signed by <key-id>)" wording. Unsigned bundles keep working with the honest wording; a bundle
   with a signature that FAILS verification is rejected (a broken signature is evidence, not noise).
3. **Generation-committed promote.** Whole-directory replacement is not portable for non-empty
   directories and was already rejected by OpenLore's analysis-generation architecture. Import
   instead stages every file on the destination filesystem, holds the analysis lock, publishes an
   explicit unavailable generation before the first replacement, atomically renames each complete
   file, and publishes `generation.json` last. Interrupted promotion is never accepted as a current
   mixed generation; the importer rebuilds before reporting success. Single-artifact readers may
   see a replacement during this interval, but no generation-aware multi-artifact read labels a
   mixed set current. SQLite sidecars are detached before the main database is replaced.
4. **Analyzed-tree disclosure.** Analysis brackets extraction with full-HEAD and working-tree
   observations, and records `sourceTreeState: clean | dirty | unknown` in `fingerprint.json`.
   Only matching clean endpoints earn `clean`; export carries that build-time fact. Measuring only
   at export would be unsound because a dirty-built graph can be exported after the tree is cleaned.
   Dirty, legacy-unknown, and locally dirty imports cannot take the "current" branch.

Authenticated bundles use format v2. This is deliberate: retaining v1 would let an older importer
ignore the new signature and repeat the old "verified current" claim. New importers still accept
legacy v1 as unsigned with unknown tree state.

Sibling: `add-incremental-bundle-delta` (its proposal defers ancestor catch-up) applies a bundle
then re-analyzes the delta — its apply path MUST inherit the same provenance wording and the
generation-committed promote; this change is the trust substrate it lands on.

Retained as-is (already solid, not re-fixed): the three-layer zip-slip guards
(`isSafeBundleFileName`, `index-bundle.ts:265-277`, checked at `:301`, `:343`, `:366`), the gunzip
`maxOutputLength` decompression cap (`:287`), manifest/payload file-list reconciliation
(`:305-310`), and execFile array-args git shell-outs.

## Why this is in scope

The bundle is the substrate's only cross-machine ingestion path: whatever it accepts becomes the
ground truth every conclusion tool cites. "Verified current" printed over unverifiable provenance
is precisely the honesty-contract violation the doctrine forbids — a conclusion without a receipt.
All fixes are local-first and deterministic: wording, a rename, one porcelain check, and an
optional ed25519 verify with keys the operator placed in their own config.

## Impact

- Files: `src/core/analyzer/index-bundle.ts` (manifest source state + optional `signature`,
  generation-committed `promoteStagedIndex`), analysis producers (source-state stamp),
  `src/cli/commands/import.ts` (wording, signature verification,
  dirty-tree currency downgrade), `src/cli/commands/export.ts` (`--sign-key`),
  `src/core/services/config-manager.ts` (read `bundle.trustedSigners`); tests for each.
- Specs: `analyzer` — 3 ADDED (BundleProvenanceIsDisclosedNotImplied,
  AtomicIndexPromotion, DirtyTreeBundlesNeverClaimCommitCurrency); `mcp-security` — 1 ADDED
  (OptInDetachedBundleSignatureVerification; complements the existing "Untrusted Artifact
  Deserialization Safety" requirement, which stays as-is).
- Tool surface: unchanged (no new MCP tool, no payload-budget impact; CLI-only flags).
- Risk: medium. Authenticated exports move to bundle format v2 so older importers rebuild rather
  than ignore the signature. Wording changes are user-visible and intended; promotion touches the
  one path that mutates the live index and is pinned by failure-prefix generation tests.
