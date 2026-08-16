# analyzer spec delta

## ADDED Requirements

### Requirement: BundleProvenanceIsDisclosedNotImplied

Bundle import SHALL distinguish integrity (the bundle is internally self-consistent: payload
digest, schema, graph-content attestation) from authenticity (the bundle came from a trusted
producer). An import whose provenance was not cryptographically verified SHALL disclose
"provenance UNVERIFIED — trust the source of this bundle" and SHALL NOT describe the result as
"verified". The word "verified" in import output is reserved for a bundle whose detached signature
validated against an operator-trusted key.

#### Scenario: Unsigned import is honest about what was proven

- **GIVEN** a bundle that passes every integrity rung and whose sourceCommit matches HEAD
- **WHEN** the user runs `openlore import`
- **THEN** the success output states the bundle is integrity-consistent and current versus the
  commit, discloses that provenance is UNVERIFIED, and contains no unqualified "verified" claim

#### Scenario: A fabricated bundle cannot borrow the strong wording

- **GIVEN** a hand-crafted bundle with fabricated graph content and a sourceCommit set to the
  importing repo's HEAD
- **WHEN** it passes the self-referential integrity checks and is imported
- **THEN** the output carries the provenance-UNVERIFIED disclosure, so the poisoned graph is never
  presented as verified truth

### Requirement: GenerationCommittedIndexPromotion

Promoting an imported bundle into the live analysis directory SHALL use the analysis lock and the
existing generation-manifest commit protocol. Before replacing the first live artifact, promotion
SHALL publish an explicit unavailable generation; after every replacement is durable, it SHALL
publish a fresh generation manifest last. A reader SHALL NOT accept an interleaved old/new artifact
set as a current generation. Whole-directory replacement SHALL NOT be used because non-empty
directory replacement is not portable and the analysis lock itself lives inside that directory.

#### Scenario: An interrupted promotion is never accepted as current

- **GIVEN** an import that has passed validation and begun promotion
- **WHEN** the process is killed at any point during promotion
- **THEN** a generation-aware read returns the prior generation, the imported generation, or
  `analysis-unavailable`; it never returns `ok` for an interleaved artifact set, and the importer
  falls back to a source rebuild before reporting success

### Requirement: DirtyTreeBundlesNeverClaimCommitCurrency

Analysis SHALL bracket extraction with source-state observations and record `clean` only when both
full commit identities match and both working-tree observations are clean; every mismatch or
observation failure SHALL become `dirty` or `unknown`. Bundle export SHALL carry that recorded state.
Import SHALL never grant commit currency to a dirty-built, legacy-unknown, or locally dirty checkout:
even when sourceCommit equals HEAD, the result is downgraded rather than called current.

#### Scenario: A dirty-built bundle is downgraded on a clean checkout

- **GIVEN** a bundle exported from a tree with uncommitted edits at commit `<sha>`
- **WHEN** a teammate on a clean checkout of `<sha>` imports it
- **THEN** the import succeeds but the currency wording is "approximately current — built from a
  dirty tree at <sha>", because the graph may encode symbols no commit contains

#### Scenario: Clean-tree exports are unaffected

- **GIVEN** a bundle exported from a clean tree at HEAD
- **WHEN** it is imported on a checkout of the same commit
- **THEN** the commit-currency verdict is unchanged from today (subject only to the provenance
  disclosure requirement)

#### Scenario: The checkout changes during analysis

- **GIVEN** analysis begins from a clean checkout and a source file or HEAD changes before extraction ends
- **WHEN** the generation is published
- **THEN** its source-tree state is dirty or unknown, never clean

#### Scenario: Importing into a dirty checkout is downgraded

- **GIVEN** a clean-built bundle whose source commit matches the importing checkout's HEAD
- **WHEN** the importing checkout has local changes
- **THEN** import reports approximate currency rather than "current at commit"

#### Scenario: A legacy bundle cannot inherit a clean claim

- **GIVEN** a bundle created before analyzed source-tree state was recorded
- **WHEN** its recorded commit matches the importing checkout's HEAD
- **THEN** import reports currency unknown; absence of the field SHALL NOT be interpreted as clean
