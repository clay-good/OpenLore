# cli spec delta

## ADDED Requirements

### Requirement: ConsoleReportsAreBoundedAndDisclosed

Console report lines whose length is a property of the ANALYZED REPOSITORY rather than of OpenLore —
a cycle's (strongly-connected component's) participant chain, a clone group's member list, the
detected-domain and workspace-shard inventories — SHALL be capped at a fixed number of names and
SHALL disclose the exact number withheld in the house `… and N more <noun>s` form. The cap is a
RENDERING cap only: what is computed and what the JSON artifacts store is unchanged, and every
capped report names the artifact that holds the full set. A quiet truncation (an ellipsis with no
count, or a dropped tail) is never acceptable. Guard tests SHALL assert both the rendered line's
length and the exact omitted count.

Third-party libraries SHALL NOT write diagnostics to OpenLore's terminal. Where a dependency offers
a diagnostic-routing option it SHALL be passed (`yaml`'s `logLevel`), and where a dependency's
warning is provoked by OpenLore's own import or call shape the call SHALL be changed so the warning
does not arise (native tree-sitter grammars are imported by their resolved entry FILE, never by an
extension-less package `main`, so Node emits no `DEP0151`). Information a suppressed warning
carried SHALL remain reachable on OpenLore's own logger at `debug` (`--verbose`) level, never
discarded. Node's warning channel is never silenced globally.

#### Scenario: A thousand-symbol cycle renders as one readable line

- **GIVEN** a repository whose strongly-connected component names 1,347 functions
- **WHEN** `openlore analyze` renders its refactoring report
- **THEN** the `⚠ Cycle:` line names a fixed few symbols and states `… and 1339 more symbols`
- **AND** `refactor-priorities.json` still lists every participant

#### Scenario: A library warning does not reach the terminal but stays reachable

- **GIVEN** a Helm template whose masked form makes `yaml` stringify a collection-valued map key
- **WHEN** `openlore analyze` parses it
- **THEN** nothing is written to the process warning channel by the library
- **AND** `--verbose` reports the stringified key, with its file path, on OpenLore's own logger

#### Scenario: Our own grammar import emits no deprecation warning

- **WHEN** OpenLore loads a native tree-sitter grammar
- **THEN** it imports the entry file the package's `main` resolves to, so no `[DEP0151]`
  DeprecationWarning is emitted, and no Node warning is suppressed to achieve it
