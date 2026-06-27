# mcp-handlers spec delta

## ADDED Requirements

### Requirement: EnvironmentVariableImpactConclusion

The MCP handler surface SHALL provide a conclusion tool `analyze_env_impact` that, given a project
directory and an environment-variable `name`, returns the deterministic impact of removing or renaming
that variable: where it is read, the functions and tests reachable from those reads, and the honesty
boundaries that bound the answer. The tool SHALL be read-only, deterministic, and offline (no LLM, no
network), and SHALL be classified `conclusion` — it returns the computed impact answer, never a
node-and-edge graph for the caller to traverse.

The tool SHALL resolve the variable against the environment-variable inventory (the cached inventory
artifact when present, or a live re-extraction when absent). When the name matches no inventory entry,
the tool SHALL return an explicit not-found result with near-name candidates — never an empty result
implying the variable is unused.

For a resolved variable the tool SHALL:

- re-read only the files the inventory associates with that variable and obtain its line-precise read
  sites via the line-precise env read-site extractor;
- map each read site to its enclosing function by containment against the cached function line spans,
  selecting the smallest enclosing span; a read site with no enclosing function SHALL be reported as a
  **module-level read** and disclosed as a boundary (it executes at import time), never silently
  dropped;
- compute the blast radius as the upstream callers of every reading function via backward
  reachability over the cached call graph, bounded by a depth limit and cycle-guarded;
- compute the reaching tests as the test nodes the same backward walk reaches;
- return the read sites (file, line, enclosing function or module-level, per-site `required`), the
  affected functions, the affected files, the reaching tests, whether the variable is declared in an
  `.env` declaration file, summary counts, and a `boundaries` list.

The result SHALL be a sound lower bound on the blast radius: dynamic dispatch, reflection, and
module-level reads, and the call graph's existing resolution limits, SHALL be disclosed in
`boundaries` rather than assumed away. Because read-site lines are obtained from the current source
but mapped to functions via the cached graph's line spans, the tool SHALL detect index staleness
(the same git-based signal the other conclusion tools use) and, when the index is stale, SHALL
disclose it (a `staleness` marker plus a boundary) noting that enclosing-function attribution and any
module-level classification may be off until the index is rebuilt — never presenting a
possibly-misattributed result as clean. The tool SHALL be scoped to the environment-variable read
patterns the analyzer supports (TypeScript / JavaScript / Python / Go / Ruby); it SHALL NOT claim to
resolve config-object key reads, which are a disclosed out-of-scope boundary.

The tool SHALL default to opt-in: it is registered on the full MCP surface and SHALL NOT appear in the
lean default (`navigation`) preset or `MINIMAL_TOOLS`.

#### Scenario: Removing a read env var reports its read sites and blast radius

- **GIVEN** a project where `DATABASE_URL` is read inside a function `connect` that is called by
  `startServer`
- **WHEN** `analyze_env_impact` is called with `name` `DATABASE_URL`
- **THEN** it returns a read site in `connect`, lists `startServer` among the affected functions, and
  lists the tests that transitively reach `connect`

#### Scenario: An unknown variable returns not-found with candidates

- **GIVEN** a project whose inventory contains `DATABASE_URL` but not `DATABSE_URL`
- **WHEN** `analyze_env_impact` is called with `name` `DATABSE_URL`
- **THEN** it returns an explicit not-found result whose candidates include `DATABASE_URL`, never an
  empty impact set

#### Scenario: A module-level read is disclosed as a boundary

- **GIVEN** a file that reads `process.env.LOG_LEVEL` at module top level (outside any function)
- **WHEN** `analyze_env_impact` is called with `name` `LOG_LEVEL`
- **THEN** the read site is reported as a module-level read and a boundary discloses that its blast
  radius is every importer of the module, computed at import time

#### Scenario: A stale index is disclosed, not presented as clean

- **GIVEN** a project whose source changed after the last `analyze` (so the cached function spans are
  stale relative to the re-read source)
- **WHEN** `analyze_env_impact` is called
- **THEN** the result carries a `staleness` marker and a boundary stating that enclosing-function
  attribution and any module-level classification may be off until the index is rebuilt

#### Scenario: The tool is opt-in, not on the lean default surface

- **GIVEN** the MCP server started with no preset selector (the lean default surface)
- **WHEN** the active tool set is resolved
- **THEN** `analyze_env_impact` is absent; it is present only under `--preset full` / `--all-tools`
