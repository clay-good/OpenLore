# mcp-handlers spec delta

## ADDED Requirements

### Requirement: DerivedGraphStructuresAreMemoizedPerAnalysis

Derived graph structures that are pure functions of the analysis artifact (forward/backward
adjacency, node map, landmark signals) SHALL be computed at most once per analysis version and
reused across tool calls, keyed on the same freshness marker as the context cache. A tool that
walks the graph SHALL NOT rebuild adjacency from scratch on every invocation.

#### Scenario: A primed orient does no full-graph rebuild

- **GIVEN** a warm server whose context cache is primed for the current analysis
- **WHEN** `orient` (or `blast_radius` / `select_tests` / `verify_claim`) runs
- **THEN** it reuses the memoized adjacency/landmarks and performs no full-graph load or
  adjacency rebuild, producing the same result as recomputing them

### Requirement: ServingCachesInvalidateOnExternalAnalyze

Server-held caches of on-disk artifacts (the graph mapping, the keyword corpus, dependency
graph, config) SHALL invalidate when an external process re-runs `openlore analyze`, via an
mtime or attestation check — a long-lived server SHALL NOT serve stale spec links or a stale
search corpus for its process lifetime.

#### Scenario: An external analyze is not invisible to the server

- **GIVEN** a long-lived MCP server and an external `openlore analyze` that rewrites the
  mapping and index
- **WHEN** the next tool call reads the affected cache
- **THEN** the cache is refreshed and the tool reflects the new analysis, not the stale one
