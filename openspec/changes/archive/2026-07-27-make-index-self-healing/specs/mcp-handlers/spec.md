# mcp-handlers spec delta

## ADDED Requirements

### Requirement: StalenessTriggersBackgroundRepair

Every read-path staleness signal that yields a verdict — integrity `mismatched`, a stale
region above threshold, a schema reset, or analysis age beyond the doctor warning threshold
— SHALL additionally trigger the shared at-most-once background repair service (the
generalized cold-start bootstrap: non-blocking, never-throw, opt-out via
`OPENLORE_NO_AUTO_ANALYZE` / `autoInit: false`). A repair that completes and still observes
its trigger SHALL disclose and stop, never loop. Detection and disclosure are unchanged;
repair is additive.

#### Scenario: A stale index heals itself behind an honest answer

- **GIVEN** a repo whose index attestation reconciles to `mismatched`
- **WHEN** any graph-dependent tool is called
- **THEN** the response is served with the existing staleness verdict plus a
  "background refresh started" note, exactly one background `analyze` starts, and a later
  call after it completes serves fresh results with no verdict

#### Scenario: Repair never blocks or lies

- **GIVEN** a background repair in flight
- **WHEN** further tool calls arrive
- **THEN** each returns without waiting on the rebuild and none presents the in-repair
  index as fresh

> Note: the next requirement was originally a MODIFIED block. Its base requirement was
> authored in `refine-happy-path-and-defaults`, which shipped without spec deltas, so the
> full statement is recorded here as an addition.

### Requirement: ReadyOrHonestFirstUse

A tool invoked against a directory with no index SHALL self-bootstrap the analysis in the
background and answer with a machine-readable not-ready shape (never stdout noise on stdio).
The not-ready/staleness conclusion SHALL additionally distinguish *repairing* from *absent*
and *stale*: when the background repair service has been triggered for the queried
directory, the conclusion carries the repair-in-progress marker and its trigger reason, so
an agent can decide to proceed on the disclosed-stale answer or retry.

#### Scenario: Absent vs stale vs repairing are distinguishable

- **GIVEN** three repos: no index, a stale index with repair running, and a fresh index
- **WHEN** the same tool is called against each
- **THEN** the responses respectively carry `reason: index-absent`, the staleness verdict
  with a repair-in-progress marker and reason, and no freshness caveat at all
