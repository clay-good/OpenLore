# Spec Delta

## ADDED Requirements

### Requirement: StalenessDisclosingHandlersServeTheOverlay

`search_code` SHALL reconcile cited stale files with the live overlay when the overlay succeeds,
and `locate_symbol_span` SHALL prefer live spans for an edited file. `search_code` SHALL also inspect
a bounded Git working-tree candidate set when the index has no symbol hits, so a newly added symbol
can be found. The answer SHALL distinguish files read from source from files still served from the
index; incoming call edges remain subject to the existing staleness disclosure.

#### Scenario: The overlay disclosure names what was read

- **GIVEN** a query whose stale set was fully overlaid
- **WHEN** the answer is produced
- **THEN** the overlay disclosure names the edited files read from source and states that incoming
  call edges can still predate the edit

#### Scenario: A skipped overlay keeps today's behavior

- **GIVEN** a query whose overlay was skipped for exceeding its bound
- **WHEN** the answer is produced
- **THEN** the indexed answer is retained with a disclosure naming why the overlay was skipped

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
