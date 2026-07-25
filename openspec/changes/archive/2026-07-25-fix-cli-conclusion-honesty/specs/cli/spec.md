# cli spec delta

## ADDED Requirements

### Requirement: BaseRefResolutionIsDisclosedOrFatal

Every CLI command accepting a `--base` ref SHALL resolve it through one shared helper. When the
requested ref does not resolve, an advisory command (blast radius, briefing) SHALL return a
structured fallback disclosure (`requested`, `resolved`) alongside its conclusion, and a
certification command (`certify-public-surface`, `impact-certificate`) SHALL fail with a non-zero
exit naming the unresolvable ref — a verdict computed against a base the user did not ask for is
never presented as a certificate — unless the user explicitly opts into disclosed fallback. A
parity test SHALL fail when a `--base` command does not route through the helper.

#### Scenario: A typo'd tag cannot produce a clean certificate

- **GIVEN** `openlore certify-public-surface --base v2.1.5-typo`
- **WHEN** the ref does not resolve
- **THEN** the command exits non-zero naming the ref, and no verdict is printed

#### Scenario: An advisory command falls back with a receipt

- **GIVEN** `openlore blast-radius --base not-a-ref`
- **WHEN** the ref does not resolve and the fallback chain selects `main`
- **THEN** the output carries the structured fallback disclosure naming both refs

### Requirement: ConclusionCommandsDiscloseIndexStaleness

Every CLI command whose conclusion is computed from the cached graph SHALL disclose index
staleness through one shared boundary shape (the index's build commit and the count of source
files changed since) whenever the working tree has moved past the index. No conclusion command may
present a risk headline or ranked briefing over a stale graph without the disclosure. A parity
test SHALL enumerate cached-graph commands and fail when one lacks the boundary path.

#### Scenario: A stale blast radius says so

- **GIVEN** an index built 90 commits ago and a `blast-radius` invocation
- **WHEN** the conclusion is printed
- **THEN** it carries the staleness boundary (build commit, changed-file count) alongside the risk
  headline

#### Scenario: Unknown enum inputs are not quiet-empty

- **GIVEN** `openlore style-fingerprint --language <unrecognized>`
- **WHEN** the language matches no known language
- **THEN** the command exits non-zero with a not-found shape listing the known languages, matching
  the honesty of its file-path counterpart
