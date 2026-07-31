# mcp-handlers spec delta

## ADDED Requirements

### Requirement: DocumentationClaimsAreCertifiedAgainstTheSubstrate

The system SHALL certify machine-checkable documentation claims against the indexed substrate.
Claims SHALL be extracted only from a closed, syntactic vocabulary — symbol references, path
references, `path:line` citations, invocations of the repository's own command surface, and
registered tool names — and each SHALL resolve to `holds`, `refuted` with counter-evidence, or
`uncheckable`. An extraction whose subject is ambiguous or external SHALL resolve to `uncheckable`,
which SHALL be counted and reported rather than silently skipped; it SHALL NOT be reported as
refuted. A documented symbol that was renamed or moved SHALL be reported as renamed with its
current name rather than as missing. Certification SHALL be deterministic, with no LLM and no
judgment of prose meaning, style, or completeness, and SHALL be advisory by default: its finding
code is gateable only through explicit enforcement policy.

#### Scenario: A stale documented symbol is refuted with evidence

- **GIVEN** documentation referencing a function that no longer exists in the index
- **WHEN** documentation claims are certified
- **THEN** that claim is `refuted` with the non-resolution as counter-evidence

#### Scenario: A drifted line citation is caught

- **GIVEN** documentation citing `path:line` for a symbol whose span no longer covers that line
- **WHEN** documentation claims are certified
- **THEN** the claim is `refuted` and names the symbol's current span

#### Scenario: A renamed symbol is reported as renamed

- **GIVEN** documentation referencing a symbol that was renamed and carried forward by identity
  continuity
- **WHEN** documentation claims are certified
- **THEN** the claim reports the rename with the current name, not a missing symbol

#### Scenario: An external or ambiguous subject is uncheckable, never refuted

- **GIVEN** documentation describing another project's command-line flag
- **WHEN** documentation claims are certified
- **THEN** the claim is `uncheckable`, is counted in the report, and is not refuted

#### Scenario: Certification is advisory unless policy says otherwise

- **GIVEN** a repository with refuted documentation claims and no enforcement policy naming the
  documentation finding code
- **WHEN** certification runs
- **THEN** the findings are reported without blocking
- **AND** the same run blocks when the policy names that code as blocking
