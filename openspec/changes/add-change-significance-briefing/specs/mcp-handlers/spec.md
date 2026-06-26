# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ChangeSignificanceBriefingTool

The system SHALL expose a catch-up briefing through an opt-in MCP tool (`briefing_since`) and a CLI
equivalent that, given a base ref (and optional region scope), returns the changed symbols since that
ref as a **ranked, labeled conclusion** — never a raw diff dump or a graph. The briefing SHALL group
changes by region/community, order them by the significance tier and raw evidence, include the tests
that should run for the change set (via the existing test-selection path), and carry each symbol's labels
and raw evidence. The cursor SHALL be the base ref, never wall-clock time. The tool SHALL declare full
input and structured output schemas and SHALL NOT enter the minimal or first-run tool surface.

#### Scenario: The briefing returns a ranked conclusion, not a diff

- **GIVEN** a base ref and a large change set
- **WHEN** an agent calls `briefing_since`
- **THEN** it receives the changed symbols grouped by region and ordered by significance tier, each with
  its labels and raw evidence and the tests to run — not a flat list of changed lines and not a graph

#### Scenario: An unresolvable base ref is disclosed, never silently substituted

- **GIVEN** an explicit base ref that git cannot resolve (e.g. a typo)
- **WHEN** an agent calls `briefing_since`
- **THEN** the briefing reports that the requested ref was not found and which base it was actually
  computed against (a `baseRefFallback` disclosure + a leading caveat), rather than silently briefing
  against the default branch as if it were the requested base

### Requirement: NoSilentTruncationOfTheBriefing

When the briefing bounds its size, it SHALL report what it dropped: the count of omitted changes and the
lowest tier it reached, so a bounded briefing is always distinguishable from a complete one. The briefing
SHALL surface the highest-tier changes first, so truncation never drops a `surprising-change` in favor of
an `ordinary-change`.

#### Scenario: A bounded briefing carries a truncation receipt

- **GIVEN** a change set larger than the briefing bound
- **WHEN** the briefing is produced
- **THEN** it includes the highest-tier changes, and a receipt stating how many changes were omitted and
  the lowest tier reached, rather than silently presenting a partial set as complete

#### Scenario: Truncation never drops a higher tier for a lower one

- **GIVEN** a change set containing both `surprising-change` and `ordinary-change` symbols that together
  exceed the bound
- **WHEN** the briefing is bounded
- **THEN** the `surprising-change` symbols are retained and the omission falls on lower-tier changes
