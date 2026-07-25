# analyzer spec delta

## ADDED Requirements

### Requirement: ArtifactBytesAreAPureFunctionOfInput

Every generated analysis artifact — including `llm-context.json` and inventory outputs —
SHALL be a pure function of the analyzed input tree and configuration: byte-identical
across repeated runs over identical input (modulo explicitly-designated timestamp fields).
Where an artifact intentionally samples its input, the sampling SHALL use a deterministic
generator seeded from the input itself (e.g. a hash of the sorted candidate list), never an
unseeded random source.

#### Scenario: Two analyzes of the same tree agree byte-for-byte

- **GIVEN** an unchanged repository analyzed twice
- **WHEN** the generated artifacts are compared with timestamps normalized
- **THEN** `llm-context.json`, the route inventory, and the env-var inventory are
  byte-identical, and the bundle digest over them is stable

#### Scenario: Sampling is seeded, not random

- **GIVEN** the phase-3 validation-file sample embedded in `llm-context.json`
- **WHEN** the same input tree is analyzed on two machines
- **THEN** both select the same validation files in the same order, because the shuffle is
  seeded from the sorted candidate list

### Requirement: ConcurrentExtractorsAggregateInInputOrder

An extractor that fans out over files concurrently SHALL aggregate its results in input
(file-list) order, not I/O-completion order: per-file results are collected individually
and flattened or upserted sequentially after the concurrent phase resolves. No serialized
output — inventory entries, synthesized edges, an env var's `files[]` list or its
first-wins description — SHALL depend on filesystem timing.

#### Scenario: Route inventory order survives adversarial latency

- **GIVEN** per-file route extraction stubbed with randomized delays
- **WHEN** the route inventory is built repeatedly over the same file list
- **THEN** the aggregated route order is identical on every run and equals the input-order
  flatten

#### Scenario: Synthesized edge bytes are stable

- **GIVEN** a repository with route-handler registrations across several files
- **WHEN** synthesized route-handler edges are generated on two runs
- **THEN** the serialized edge order is identical, keeping the graph bytes a pure function
  of the input

#### Scenario: An env var's provenance is input-ordered

- **GIVEN** an env var read in several files, more than one carrying a declaration comment
- **WHEN** the env inventory is extracted repeatedly
- **THEN** the var's `files[]` order and its winning description are the same every run,
  determined by file-list order rather than read-completion order
