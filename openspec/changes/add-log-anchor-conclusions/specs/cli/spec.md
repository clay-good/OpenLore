# cli spec delta

## ADDED Requirements

### Requirement: HookMomentsResolveLogLinesToTheirEmitter

When a shell command reported to the `after-tools` hook moment exits non-zero, and when a prompt
reaches the prompt-submitted injection, the system SHALL match that text against the log template
index and SHALL add each resolved origin to the hook's context with its file, line, enclosing
function, and matched constant parts. The item SHALL be advisory and stated once per session. A
command that exits zero SHALL run no matching.

#### Scenario: A failed command's error line arrives with its origin

- **WHEN** a shell command exits non-zero and its output contains `payment 84c2 failed after 3 retries`
- **THEN** the `after-tools` receipt names the emitting call site by file and line, its enclosing
  function, and the constant parts that matched

#### Scenario: An ambiguous line does not produce a guess

- **WHEN** more than three templates tie for the same line
- **THEN** the hook adds nothing for that line

#### Scenario: A passing command costs nothing

- **WHEN** a shell command exits zero
- **THEN** no template matching runs and the hook stays silent
