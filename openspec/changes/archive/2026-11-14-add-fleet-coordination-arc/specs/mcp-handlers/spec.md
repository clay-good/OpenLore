# mcp-handlers spec delta

## ADDED Requirements

### Requirement: FleetVerificationMemorySurvivesBaseDrift

The system SHALL hold, under the opt-in coordination preset, a verification memory of typed anchored
records, each carrying the base commit it was proven against and the symbols it was proven over.
When a live record is read in the worktree that recorded it, the system SHALL decide its state
deterministically with the freshness lease — `still-valid`, `invalidated` (an anchored symbol
changed), or `needs-reverification` (an anchor cannot be located, carries no content hash, or
cannot be checked) — and SHALL NOT serve a record as fresh without a graph to check it against. A
record from another worktree and an ended record are not classified here; see
`FleetRecordsAndPlansUseTheBoard`. The `fleet_status` conclusion SHALL report the classified records and the peer
board summary, and SHALL point to the dispatch, in-flight, and landing tools by name without running
them. Where records live, when they end, and the disclosure that no tool records a verdict yet are
stated in `FleetRecordsAndPlansUseTheBoard`.

#### Scenario: A still-valid record is reported without re-verification

- **GIVEN** a record proven against base commit X, read in the worktree that recorded it, and the
  base advances to Y touching unrelated code
- **WHEN** `fleet_status` is read before the record ends
- **THEN** the record is `still-valid`

#### Scenario: Drift invalidates the record

- **GIVEN** a live record, read in the worktree that recorded it, whose proven symbols a later
  commit changed
- **WHEN** `fleet_status` is read
- **THEN** the record is `invalidated`, not fresh

#### Scenario: A lost anchor is never silently trusted or dropped

- **GIVEN** a live record, read in the worktree that recorded it, whose anchored symbol can no
  longer be located
- **WHEN** `fleet_status` is read
- **THEN** the record is `needs-reverification`, surfaced as such, neither served fresh nor dropped
