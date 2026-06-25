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
