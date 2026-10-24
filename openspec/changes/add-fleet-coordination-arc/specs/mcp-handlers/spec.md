# mcp-handlers spec delta

## ADDED Requirements

### Requirement: FleetVerificationMemorySurvivesBaseDrift

The system SHALL provide, under the opt-in coordination preset, a verification memory that records a
coordination verdict (a clean blast radius, a stable public surface, a passed merge certification)
as a typed anchored record carrying the exact base commit it was proven against and the symbols it
was proven over. When the base advances, the system SHALL decide each record's fate deterministically
using the freshness lease and symbol-identity continuity — `still-valid`, `carried` (symbols moved
but unchanged), `invalidated` (a dependency changed, with the invalidating commit as the receipt),
or `needs-reverification` (anchor lost) — and SHALL NOT serve a verdict as fresh once its base moved
without this check. The system SHALL also provide a `fleet_status` conclusion that composes, for a
set of in-flight branches, the dispatch plan, the current conflict map, the landing certificates,
and the still-valid verification records into one readiness view, each line attributed to the phase
and tool that produced it, referencing those tools rather than re-deriving them. Unindexed languages,
dynamic-dispatch edges, and diff-fetch failures SHALL be disclosed as not-assessed.

#### Scenario: A still-valid verdict is reused, not re-proven

- **GIVEN** a recorded clean blast-radius verdict proven against base commit X, and the base
  advances to Y touching unrelated code
- **WHEN** the base-drift check runs
- **THEN** the record is `still-valid` and `fleet_status` reports it without re-verification

#### Scenario: Drift invalidates the verdict with a receipt

- **GIVEN** a recorded verdict whose proven symbols a later base commit changed
- **WHEN** the base-drift check runs
- **THEN** the record is `invalidated` and names the invalidating commit, and `fleet_status` shows
  it as needing re-verification rather than fresh

#### Scenario: A moved-but-unchanged symbol carries

- **GIVEN** a recorded verdict whose proven symbol was renamed or moved without a body change
- **WHEN** the base-drift check runs
- **THEN** the record is `carried` with re-pointed anchors, not invalidated

#### Scenario: The readiness view is composed, not re-derived

- **WHEN** `fleet_status` runs over a set of in-flight branches
- **THEN** it returns the dispatch plan, conflict map, landing certificates, and still-valid
  verdicts as one view, each line attributed to its producing tool, with no finding re-computed in a
  way that could disagree with that tool

#### Scenario: A lost anchor is never silently trusted or dropped

- **GIVEN** a recorded verdict whose anchored symbol can no longer be located
- **WHEN** the base-drift check runs
- **THEN** the record is `needs-reverification`, surfaced as such, neither served fresh nor dropped
