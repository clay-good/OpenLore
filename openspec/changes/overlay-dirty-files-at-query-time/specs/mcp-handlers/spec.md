# Spec Delta

## ADDED Requirements

### Requirement: StalenessDisclosingHandlersServeTheOverlay

Every handler that discloses index staleness SHALL serve the live overlay for the stale set when the
overlay succeeded, and SHALL keep its existing disclosure for whatever the overlay did not cover. The
disclosure SHALL state which of the two happened, so a caller is never left unable to tell a served
overlay from a plain stale answer.

#### Scenario: The notice narrows to what is still stale

- **GIVEN** a query whose stale set was fully overlaid
- **WHEN** the answer is produced
- **THEN** the staleness notice names no remaining stale file and states that the edited files were
  read from source

#### Scenario: A skipped overlay keeps today's behavior

- **GIVEN** a query whose overlay was skipped for exceeding its bound
- **WHEN** the answer is produced
- **THEN** the existing staleness notice is returned unchanged, plus the reason the overlay was
  skipped

### Requirement: ExactPositionsPreferTheOverlay

A handler that returns exact source positions SHALL prefer overlaid spans over indexed spans for any
file in the stale set, so positions handed to an editing caller match the bytes on disk. When no
overlay is available for such a file, the handler SHALL keep its existing warning that the recorded
offsets are not trustworthy.

#### Scenario: Positions in an edited file are current

- **GIVEN** a request for a symbol's span in a file edited since the index was built
- **WHEN** the overlay covered that file
- **THEN** the returned offsets address the current bytes, with no untrustworthy-offset warning

#### Scenario: Without an overlay the warning stands

- **GIVEN** the same request when the overlay was skipped
- **WHEN** the span is returned
- **THEN** the existing untrustworthy-offset warning is returned with it
