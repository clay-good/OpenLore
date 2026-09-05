# mcp-handlers spec delta

## ADDED Requirements

### Requirement: DerivedGraphStructuresAreMemoizedPerAnalysis

The adjacency structures that are pure functions of the analysis artifact — forward/backward
adjacency, the node map, and the call-distance-weighted adjacency — SHALL be computed at most once
per analysis version and reused across tool calls, keyed on the artifact generation the context
cache is keyed on. A tool that walks the graph SHALL NOT rebuild adjacency from scratch on every
invocation.

This names adjacency only. Signals that take per-call inputs beyond the graph (landmark
classification, which is parameterized by churn and dead-code sets) are outside it: they are not
pure functions of the artifact, so memoizing them per analysis version would not be sound.

#### Scenario: A primed orient does no full-graph adjacency rebuild

- **GIVEN** a warm server whose context cache is primed for the current analysis
- **WHEN** `orient` (or `blast_radius` / `find_path` / `analyze_impact`) runs
- **THEN** it reuses the memoized adjacency and performs no full-graph adjacency rebuild,
  producing the same result as recomputing it

### Requirement: ServingCachesInvalidateOnExternalAnalyze

Server-held caches of on-disk artifacts — the graph mapping, the keyword corpus, and the
dependency graph — SHALL invalidate when an external process rewrites the artifact they hold, via
an identity-stamp or attestation check. A long-lived server SHALL NOT serve stale spec links or a
stale search corpus for its process lifetime.

The stamp SHALL describe the bytes actually served: it is taken from the same descriptor the read
came from, so a rewrite landing mid-read causes a miss rather than caching old content under the
new file's identity. Repository configuration is deliberately NOT in this list — it is re-read
rather than cached, so it has nothing to invalidate.

#### Scenario: An external analyze is not invisible to the server

- **GIVEN** a long-lived MCP server and an external `openlore analyze` or `openlore generate` that
  rewrites the mapping and index
- **WHEN** the next tool call reads the affected cache
- **THEN** the cache is refreshed and the tool reflects the new analysis, not the stale one
