## ADDED Requirements

### Requirement: DeadFlaggedGapsRankBelowLiveGaps

`report_coverage_gaps` SHALL rank a gap flagged `alsoFlaggedDead` below every gap that is not so flagged, regardless of its significance signals or fan-in. Within each of the two groups the existing order SHALL apply unchanged: load-bearing label first, then raw fan-in, then a stable file-and-name tiebreak.

Ranking SHALL remain deterministic and derived from existing labels; no composite score and no new tuning constant SHALL be introduced.

#### Scenario: A dead-flagged hub does not outrank a live gap

- **GIVEN** a dead-flagged gap with the `hub` signal and fan-in 26, and a live gap with no significance signal and fan-in 1
- **WHEN** the gaps are ranked
- **THEN** the live gap is returned before the dead-flagged hub

#### Scenario: Order within a group is unchanged

- **GIVEN** two live gaps, one labelled `chokepoint` and one unlabelled with higher fan-in
- **WHEN** the gaps are ranked
- **THEN** the labelled gap precedes the unlabelled one, as it does today

#### Scenario: Truncation does not hide every live gap

- **GIVEN** more dead-flagged gaps than the result limit and at least one live gap
- **WHEN** the result is truncated to `maxResults`
- **THEN** every returned live gap precedes any dead-flagged gap, and the truncation receipt states how many of each were omitted

### Requirement: DeadFlagCarriesItsReason

A gap flagged `alsoFlaggedDead` SHALL carry a stable reason: `no-callers` when its fan-in is zero, and `dead-via-unreachable-callers` when its fan-in is above zero and it is still unreachable from an entry point. The existing `alsoFlaggedDead` boolean SHALL keep its current meaning.

The result SHALL state that `dead-via-unreachable-callers` marks a reachability the analysis could not decide — the signature of a dynamic, reflective, or registry-mediated inbound edge — and SHALL NOT present it as evidence that the code is unused.

#### Scenario: Resolved callers that are themselves unreachable

- **GIVEN** a symbol with 26 resolved callers, all of them unreachable from any entry point
- **WHEN** it is reported as a gap
- **THEN** it carries `alsoFlaggedDead` with reason `dead-via-unreachable-callers`, and the result names the undecided-reachability caveat

#### Scenario: A genuinely uncalled symbol

- **GIVEN** a symbol with no resolved caller
- **WHEN** it is reported as a gap
- **THEN** it carries `alsoFlaggedDead` with reason `no-callers`

### Requirement: GapPageDisclosesItsComposition

The result SHALL report how many of the returned gaps are live and how many are dead-flagged, and the same split for the omitted remainder. A caller SHALL be able to tell a page of untested load-bearing code from a page of undecidable reachability without inspecting every entry.

#### Scenario: A mostly dead-flagged gap set is legible at a glance

- **GIVEN** 264 gaps of which 210 are dead-flagged
- **WHEN** the first page of 20 is returned
- **THEN** the response states the live and dead-flagged counts for both the returned page and the omitted remainder
