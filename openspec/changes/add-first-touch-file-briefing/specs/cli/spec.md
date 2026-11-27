# cli spec delta

## ADDED Requirements

### Requirement: FirstTouchOfAFileIsBriefedOnce

The first time in a session that the agent reads a file with the `Read` tool, or edits a file it
has not read, `openlore hook` SHALL print at most 6 lines about that file. Each line SHALL be a fact
with its proof from a closed list: callers in other files, anchored decisions and memories,
served contracts, asserting tests (edit moment only), and commits since the previous session. The
hook SHALL NOT block the read or the edit.

#### Scenario: A depended-on file is briefed on first read

- **GIVEN** an indexed file whose function `parseConfig` has 9 callers in 4 other files
- **WHEN** the agent reads the file for the first time in the session
- **THEN** the hook output names `parseConfig`, 9 callers, 4 files, and up to 2 caller files

#### Scenario: A stale memory is not served as fact

- **GIVEN** a memory anchored to a symbol in the file whose anchor drifted
- **WHEN** the file is briefed
- **THEN** the memory is counted as stale and its text is not printed

#### Scenario: Already served by orient

- **GIVEN** `orient` served symbol `parseConfig` earlier in the session
- **WHEN** the file is briefed
- **THEN** the caller line for `parseConfig` is left out

### Requirement: FirstTouchBriefingIsSilentWithoutNews

The first-touch briefing SHALL print nothing when no line has a fact, when the file is not in the
index, or when the file was already briefed in the session. A repeat touch SHALL NOT load the graph.

#### Scenario: A second read is silent

- **WHEN** the agent reads the same file again in the same session
- **THEN** the hook prints nothing and does not load the graph

#### Scenario: Nothing to say

- **GIVEN** a file with no callers in other files, no anchored decision or memory, and no contract
- **WHEN** the agent reads it for the first time
- **THEN** the hook prints nothing

#### Scenario: The moment is turned off

- **GIVEN** `hooks.after-read: false` in `.openlore/config.json`
- **WHEN** the agent reads a file
- **THEN** the hook prints nothing
