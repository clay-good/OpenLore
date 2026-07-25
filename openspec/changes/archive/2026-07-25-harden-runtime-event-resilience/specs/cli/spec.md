# cli spec delta

## ADDED Requirements

### Requirement: LiveTelemetryTailSurvivesErrorsAndRotation

The `telemetry --live` tail SHALL attach an `'error'` handler to every read stream it opens:
a stream error MUST NOT crash the live session and MUST clear the per-file in-flight guard so
the file's tail can retry on the next watch event, with a one-line diagnostic disclosure.
Before opening a stream at a stored offset, the tail SHALL detect log rotation structurally —
a current file size smaller than the stored offset means the file was rotated and restarted —
and reset the offset to the start of the new file, so rotation never produces a silently
empty tail.

#### Scenario: A stream error does not end the live session

- **GIVEN** `openlore telemetry --live` tailing a telemetry file
- **WHEN** the read stream emits `'error'` (for example, the file was renamed away by
  rotation between the watch event and the open)
- **THEN** the session keeps running, one diagnostic line is printed, the in-flight guard is
  cleared, and a later event on the same file is rendered

#### Scenario: Rotation resets the offset instead of wedging the tail

- **GIVEN** a telemetry file that was rotated (renamed at the size threshold and restarted
  small) while a stale byte offset is stored for it
- **WHEN** the next watch event triggers a tail of that file
- **THEN** the size-below-offset condition is detected, the offset resets to 0, and the new
  file's lines are rendered — the tail never reads silently past end-of-file forever
