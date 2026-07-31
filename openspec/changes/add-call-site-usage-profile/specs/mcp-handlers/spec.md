# mcp-handlers spec delta

## ADDED Requirements

### Requirement: CallSiteUsageProfileIsDescriptive

The system SHALL provide an opt-in `get_usage_profile` conclusion tool that, for one resolved
symbol, computes a deterministic census of its resolved call sites: argument-count distribution,
literal-versus-variable per position, named options passed, result context (awaited, returned,
assigned, discarded), and enclosing error-handling context — each facet reported as dominant
choice, ratio, and sampled file:line receipts. The profile SHALL be descriptive only: observed
frequency, never a correctness or lint judgment. A facet below the evidence floor SHALL report a
null signal; a call site whose facet is syntactically uncountable (spread or dynamic arguments)
SHALL be disclosed as uncountable rather than guessed; call sites reachable only through
synthesized or low-confidence edges SHALL be excluded with the exclusion disclosed. An unknown
symbol SHALL return not-found with candidates, an ambiguous name SHALL return path-qualified
candidates, and an unsupported language SHALL return an explicit unsupported result — never an
empty profile implying the symbol is never called.

#### Scenario: The profile reports how the codebase calls the symbol

- **GIVEN** a symbol with twenty resolved call sites, seventeen of which pass a `timeout` option
  and all of which await the result
- **WHEN** `get_usage_profile` runs
- **THEN** the options facet reports `timeout` dominant at 0.85 and the result-context facet
  reports awaited at 1.0, each with sample receipts

#### Scenario: Thin evidence yields null, not a guess

- **GIVEN** a symbol with two call sites
- **WHEN** a facet falls below the evidence floor
- **THEN** that facet reports a null signal with the site count

#### Scenario: The uncountable is disclosed

- **GIVEN** a call site invoking the symbol with spread arguments
- **WHEN** the census runs
- **THEN** that site is counted for the facets it can support and disclosed uncountable for
  arity, and no facet total silently omits it

#### Scenario: Resolution failures are explicit

- **GIVEN** a query for a name matching no indexed symbol, and a second query matching several
- **WHEN** the tool runs
- **THEN** the first returns not-found with candidates and the second returns path-qualified
  candidates, and neither returns an empty profile
