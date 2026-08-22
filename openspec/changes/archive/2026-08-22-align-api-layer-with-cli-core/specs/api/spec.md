# api spec delta

## ADDED Requirements

### Requirement: ApiIsAFacadeOverTheCliCore

The programmatic API (`openloreAnalyze` / `openloreRun` / `openloreGenerate`) SHALL be a facade
over the same analysis and generation core the CLI uses, not a parallel reimplementation. In
particular it SHALL respect the config include/exclude patterns, write `fingerprint.json`, run the
inventory extractors, build the keyword/spec indexes, and resolve the LLM provider identically to
the CLI, so an index produced through the API is equivalent to one produced by `openlore analyze`.

#### Scenario: Analyze through the API matches the CLI

- **GIVEN** a repo with configured exclude patterns and a keyless configured provider
- **WHEN** an embedder calls `openloreAnalyze` (or `openloreRun`)
- **THEN** excludes are respected, `fingerprint.json` is written, the inventories and indexes are
  built, and the keyless provider resolves — the same as the CLI

### Requirement: ApiResultsDiscloseCacheAndDegradation

API results SHALL disclose whether they were served from cache (a `fromCache` marker) and SHALL
disclose a missing or corrupt artifact as a degraded result rather than substituting a fabricated
empty graph. One freshness predicate SHALL govern both entry points.

#### Scenario: A cached or degraded result is not mistaken for fresh/complete

- **GIVEN** a stale cache or a missing dependency-graph artifact
- **WHEN** an API function returns
- **THEN** the result carries `fromCache: true` (for cache) or a disclosed degraded/missing field
  (for the artifact), never an undisclosed all-zeros graph

### Requirement: ApiHasNoConsoleSideEffectsAndTypedErrors

The API SHALL make no console side effects when a quiet/logger option is set (so a host using
stdout for protocol framing is not corrupted), SHALL throw typed `OpenLoreError` values with stable
codes (`no-config`, `no-analysis`, `no-api-key`, `pipeline-failed` carrying `cause`) rather than raw
internal errors, SHALL report its real package version, and SHALL type dry-run results honestly.

#### Scenario: An embedder branches on error codes without string-matching

- **GIVEN** a repo with no analysis
- **WHEN** an API function is called
- **THEN** it throws `OpenLoreError` with a stable `no-analysis` code, and emits no console output
  under the quiet option
