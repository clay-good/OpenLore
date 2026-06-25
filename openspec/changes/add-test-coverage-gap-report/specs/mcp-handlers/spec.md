# mcp-handlers spec delta

## ADDED Requirements

### Requirement: CoverageGapReportTool

The system SHALL expose the structural coverage gap through an opt-in MCP tool (`report_coverage_gaps`)
and a CLI equivalent that return the ranked untested surface as a **conclusion** — a ranked list of
symbols with their significance labels, raw evidence, and the soundness caveat — never a graph. The tool
SHALL optionally scope the report to a region/community or to the symbols a given diff touches, so an
agent can ask "is the part of *this change* untested?". The tool SHALL declare full input and structured
output schemas, SHALL carry the explicit disclosure that it reports gaps (no reaching test) and never
certifies that anything is tested, and SHALL NOT enter the minimal or first-run tool surface.

#### Scenario: The tool returns a ranked untested surface, not a graph

- **GIVEN** an analyzed repository
- **WHEN** an agent calls `report_coverage_gaps`
- **THEN** it receives a ranked list of untested symbols with labels and evidence and the soundness
  caveat, not a node-and-edge structure

#### Scenario: Scoping to a diff answers "is this change untested?"

- **GIVEN** a diff and a call to `report_coverage_gaps` scoped to that diff
- **WHEN** the report is produced
- **THEN** it returns the changed symbols that have no reaching test, ranked by significance, so a
  reviewer can see whether the risky part of the change is untested

### Requirement: ScopedCoverageReportDenominatorsAndDisclosure

When the report is scoped (to a diff via changed symbols / a diff ref, or to a region via a file
pattern), the reported counts (analyzed-symbols and reachable-from-a-test) SHALL range over the
**in-scope** candidate set, not the whole repository, so a scoped call's denominator matches its scoped
gaps. A file-pattern filter, when supplied, SHALL be echoed in the output whenever it is applied
(including when layered on a diff scope), so the narrowing is never silent. A scope that resolves to
**no in-scope symbol** (an unresolved/typo'd symbol, a diff touching no analyzed production code, or a
file pattern matching nothing) SHALL return an explicit disclosure that nothing matched — never a bare
zero gap count that would read as the reassuring "this change is fully covered".

#### Scenario: A scoped report's denominators are scoped, not repo-wide

- **GIVEN** a call scoped to a single changed symbol that is itself an untested gap
- **WHEN** the report is produced
- **THEN** the analyzed-symbols and reachable-from-a-test counts cover only the in-scope set (e.g.
  "1 gap of 1 analyzed"), not the whole repository's symbol count

#### Scenario: A scope that matched nothing is disclosed, not reported as zero gaps

- **GIVEN** a scope whose symbols/files/pattern resolve to no in-scope production function
- **WHEN** the report is produced
- **THEN** it returns an explicit "nothing matched" disclosure rather than a bare zero gap count, so a
  typo or an unanalyzed change can never read as "fully covered"

### Requirement: CoverageReportTrustDisclosuresSurfaced

Both the MCP and CLI surfaces SHALL carry the index trust signals the report rests on — the
index-vs-working-tree staleness marker and a non-healthy index-integrity verdict — because the report's
output is entirely **negative** conclusions ("no reaching test") and a stale or degraded index can
manufacture false gaps. The CLI human view SHALL surface these (not only the JSON), alongside the
precise partial-test-detection caveat naming the languages whose gaps may be over-reported.

#### Scenario: A stale or degraded index is surfaced in the human view

- **GIVEN** a report computed over an index that is stale relative to the working tree (or did not
  reconcile its integrity attestation)
- **WHEN** the human-readable CLI report is rendered
- **THEN** the staleness / integrity caveat is shown to the reviewer, not silently dropped to JSON only

### Requirement: CoverageReportStrictResolutionOption

The report MAY restrict test-reachability to directly-resolved call edges only (ignoring synthesized
dynamic-dispatch edges), trading completeness for certainty — reporting more gaps, more certainly. When
this strict option is used, the also-dead labeling SHALL be computed on the **same** edge basis as the
gap partition, so the gap set and the also-dead set never rest on disagreeing resolutions.

#### Scenario: Strict mode keeps the gap and also-dead partitions on one basis

- **GIVEN** a function reachable from a test ONLY through a synthesized dynamic-dispatch edge
- **WHEN** the report is produced with the strict (directly-resolved-only) option
- **THEN** the function is reported as a gap, and because the dead set uses the same strict basis it is
  also labeled also-dead — the two conclusions never disagree
