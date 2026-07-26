# cli spec delta

## ADDED Requirements

### Requirement: PortableFactCacheIsContentAddressedAndTrustChecked

The CLI SHALL provide export and import of the Pass-1 fact cache as a single portable,
content-addressed archive, so a cache warmed on one machine or CI job can be restored on another
without a network service, a daemon, or a hosted endpoint.

Every imported entry SHALL be validated before use: its content-hash key, the extractor-purity
stamp, and the schema version SHALL all match the importing installation. An entry failing any
check SHALL be ignored and recomputed — never served, never partially trusted, and never cause
the import or a subsequent analyze to fail. Import SHALL report how many entries were accepted,
how many were rejected, and why.

An imported cache SHALL NOT change the resulting graph: an analyze performed against a warm
imported cache SHALL produce byte-identical output to the same analyze performed cold. The
existing bypasses that ignore the fact cache SHALL continue to bypass an imported one.

#### Scenario: A CI job restores a warm cache

- **GIVEN** a cache archive exported from an analyze on another machine running the same version
- **WHEN** it is imported and the repository is analyzed
- **THEN** the analyze reuses the accepted entries, reports the accepted and rejected counts, and
  produces output byte-identical to a cold analyze of the same commit

#### Scenario: A stamp mismatch is ignored, not served

- **GIVEN** an archive exported by an installation with a different extractor-purity stamp
- **WHEN** it is imported
- **THEN** every mismatched entry is rejected with a stated reason, the analyze recomputes them,
  and no stale fact reaches the graph

#### Scenario: A corrupt archive never breaks the build

- **GIVEN** a truncated or malformed cache archive
- **WHEN** it is imported
- **THEN** the import reports the failure, no entries are trusted, and a subsequent analyze
  completes normally from cold
