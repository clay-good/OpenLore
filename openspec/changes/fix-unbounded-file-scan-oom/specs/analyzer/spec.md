# analyzer spec delta

## ADDED Requirements

### Requirement: RepositoryWideScansAreBoundedInConcurrencyAndFileSize

A scan that reads every file in a repository SHALL bound both the number of files it holds in
memory at once and the size of any single file it will read. Neither bound alone is sufficient: a
repository of many ordinary files exhausts the heap through fan-out, and a repository containing
one generated blob exhausts it through a single read.

The per-file size SHALL be measured BEFORE the file is read. Reading first and measuring after has
already allocated exactly what the cap exists to prevent.

Peak residency SHALL be a function of the bounds, not of the repository's file count or total
bytes.

#### Scenario: A large repository is scanned under a small heap

- **GIVEN** a repository of several hundred megabytes of source across hundreds of files
- **WHEN** the enrichment extractors scan it under a heap far smaller than the repository
- **THEN** every extractor completes, and peak memory tracks the concurrency bound rather than the
  repository size

#### Scenario: One oversized file cannot exhaust the heap

- **GIVEN** a repository containing a single generated file far larger than the per-file cap
- **WHEN** a repository-wide scan runs
- **THEN** that file is skipped without being read into memory, and the other files are scanned
  normally

### Requirement: BoundedScansPreserveInputOrder

A bounded repository-wide scan SHALL return its results in INPUT order, identically to an unbounded
`Promise.all`, and independently of its concurrency width.

This is a correctness property, not a convenience. Artifacts built from these scans must be
byte-identical across runs of a fixed repository state; under a concurrency bound, completion order
depends on which worker frees a slot first, so input-order aggregation is the only thing keeping
those bytes stable.

#### Scenario: Adversarial completion order does not reorder output

- **GIVEN** a file list longer than the concurrency bound, whose reads complete in reverse order
- **WHEN** the route and env-var inventories are built from it
- **THEN** both are ordered by the file list, and repeated runs produce identical bytes

### Requirement: FilesTooLargeToScanAreDisclosed

A file excluded from an enrichment scan because it exceeds the per-file size cap SHALL be disclosed
to the operator with its path and size, and the affected inventories SHALL be described as a LOWER
BOUND.

A silently dropped file makes a component, route, or environment variable that genuinely exists
read as genuinely absent — the failure mode the analyzer's disclosure discipline exists to prevent.
The disclosure SHALL be derived from the same threshold the scan applies, so the two surfaces
cannot report different answers for the same repository.

#### Scenario: An oversized file is reported rather than dropped

- **GIVEN** a repository containing a file above the scan's per-file cap
- **WHEN** `openlore analyze` runs
- **THEN** the run completes and reports the excluded file, its size, and that the enrichment
  inventories are a lower bound

### Requirement: EnrichmentExtractorsDoNotMultiplyTheScanBound

The enrichment extractors SHALL NOT run as one concurrent batch. Each is internally bounded;
running them together multiplies that bound by the number of extractors, which is what exhausted
the heap. Running them in sequence costs no additional I/O, since they read the same file set.

#### Scenario: Adding an extractor does not raise peak memory

- **GIVEN** the enrichment phase of `openlore analyze`
- **WHEN** the extractors run
- **THEN** peak residency is that of a single bounded scan, regardless of how many extractors the
  phase contains
