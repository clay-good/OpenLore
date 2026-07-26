# cli spec delta

## ADDED Requirements

### Requirement: PortableFactCacheIsIntegrityCheckedAndTreatedAsUntrusted

The CLI SHALL provide export and import of the Pass-1 fact cache as a single portable,
content-addressed archive, so a cache warmed on one machine or CI job can be restored on another
without a network service, a daemon, or a hosted endpoint.

**The archive's checks are integrity checks, not authenticity checks.** A content-hash key proves
an entry names a file the importer already has, and the purity stamp proves it was produced by
matching extraction code — neither proves the recorded *facts* are the facts that code would
produce, because the stored value is opaque and covered by no digest. An imported cache SHALL
therefore be treated as an **untrusted, privileged input**: it silently determines what the graph
says, and the graph feeds dead-code, coverage-gap, and enforcement conclusions.

Accordingly:

- Import SHALL disclose provenance as **unverified** and SHALL NOT use the word "verified" for an
  unsigned archive.
- An imported cache SHALL NOT be consulted by any analyze feeding a **blocking** enforcement
  decision — the commit gate, a configured covering surface, a CI gate — unless the archive
  carries a signature from a key in the importing installation's configured trusted signers. In
  the unsigned case such an analyze SHALL bypass the imported entries and recompute.
- Signature verification SHALL reuse the mechanism specified for graph bundles rather than
  defining a second one; a present-but-failing signature SHALL cause **rejection**, not a
  downgrade to unsigned.
- This change SHALL NOT ship its import path before that mechanism ships.

**The key SHALL cover every input the purity stamp cannot see across a machine boundary** — at
minimum the runtime layout the extractor was loaded from (source vs. built distribution), the
Node major version and ABI, and the platform/architecture triple. An entry not matching on all of
these SHALL be ignored and recomputed, so a mismatch costs a miss rather than a divergence.

Byte-identity with a cold analyze on the importing machine SHALL NOT be claimed: grammar
loadability is a property of the running process — ABI, prebuilt binary availability, a transient
load failure — invisible to both the content hash and the stamp. The guarantee is that an
imported cache does not change the graph **relative to what the importing installation's own
extraction would produce**, and the gap SHALL be disclosed as a named boundary.

Import SHALL report the hit rate it will achieve and, when zero entries are usable, SHALL name
the cause — stamp, layout, ABI, path, or content mismatch — rather than reporting a successful
import of an unusable archive. An entry failing any check SHALL be ignored and recomputed, never
partially trusted, and never fatal.

**Export SHALL disclose what leaves the machine.** Export SHALL apply the repository's
secret-redaction pass to every exported field carrying repository-authored prose or identifiers —
at minimum docstrings and signatures — and SHALL state at export time that the archive contains
file paths, function/class/method/parameter/local identifiers, docstring text, and normalized
signatures. Export SHALL NOT be silent that a private repository's identifier and comment surface
is leaving the machine.

#### Scenario: A CI job restores a warm cache

- **GIVEN** an archive exported from a machine with a matching stamp, layout, ABI, and platform
- **WHEN** it is imported and the repository is analyzed
- **THEN** the accepted entries are reused, accepted and rejected counts are reported, and the
  result matches what this installation's own extraction would produce

#### Scenario: An unsigned cache never feeds a blocking gate

- **GIVEN** an unsigned imported archive and a commit gate configured to block
- **WHEN** the gating analyze runs
- **THEN** the imported entries are bypassed and recomputed, and the gate's verdict rests on
  locally-derived facts

#### Scenario: A layout mismatch costs a miss, not a divergence

- **GIVEN** an archive exported from a source checkout and imported by an installation running
  the built distribution
- **WHEN** it is imported
- **THEN** the entries are rejected with the layout cause named, the hit rate is reported as
  zero, and the analyze recomputes

#### Scenario: A corrupt archive never breaks the build

- **GIVEN** a truncated or malformed archive
- **WHEN** it is imported
- **THEN** the failure is reported, no entries are trusted, and a subsequent analyze completes
  normally from cold

### Requirement: ShardSelectionIsResolvedHonestlyOrRefused

`analyze --shard <name>` SHALL resolve the name against the detected shard list. An unrecognized
name SHALL be a **fatal error naming the available shards and the nearest candidates**; it SHALL
NOT fall back to a full analyze, to the root shard, or to analyzing nothing. `--shard` invoked
where no index exists SHALL perform a full analyze and say so, since there is no stored graph to
retain. The combination of `--shard` with a forced rebuild SHALL be defined explicitly and
reported. Every shard-scoped run's epilogue SHALL name the shards recomputed, the shards retained
with their last-recomputed state, the frontier size, and any region marked stale, and SHALL NOT
use wording that reads as a full analyze.

#### Scenario: A misspelled shard is refused, not silently widened

- **GIVEN** `--shard payments-api` where the detected shards are `payments`, `api`, and `root`
- **WHEN** the command runs
- **THEN** it exits fatally naming the available shards and the nearest candidates, and no
  analyze is performed

#### Scenario: No index means a full analyze, disclosed

- **GIVEN** `--shard payments` on a repository with no existing index
- **WHEN** the command runs
- **THEN** a full analyze is performed and the epilogue states that scoping was not applied
