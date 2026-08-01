# cli spec delta

## ADDED Requirements

### Requirement: OutputContractsAreUniform

CLI output SHALL honor a uniform set of contracts across every command: (1) color output flows
through the shared logger/color layer and respects `--no-color` and non-TTY streams — no raw ANSI
escape literals in command modules, enforced by a guard test; (2) an explicitly-passed `--config`
path that does not resolve is a fatal error naming the path, never a silent fallback to defaults;
(3) summary lines describe the warnings actually emitted, not a hardcoded assumption; (4) hints and
error messages name commands in the vocabulary of the surface that produced them (CLI hints name
CLI commands, MCP hints name MCP tools); (5) status glyphs are visually distinct and accompanied by
a legend wherever a status can gate a workflow (a decision awaiting review is never rendered with a
done-reading glyph).

#### Scenario: Piped output is clean

- **GIVEN** `openlore --no-color decisions --list` piped to a file
- **WHEN** the output is inspected
- **THEN** it contains no ANSI escape bytes

#### Scenario: A missing explicit config cannot be silently ignored

- **GIVEN** `openlore --config /path/that/does/not/exist.json enforce`
- **WHEN** the command starts
- **THEN** it exits non-zero naming the path before evaluating any policy

#### Scenario: A gate-blocking status reads as such

- **GIVEN** a decision store whose decisions are all `verified` (awaiting human review)
- **WHEN** `openlore decisions --list` renders them
- **THEN** the rows read as awaiting review, visually distinct from approved/synced, with a legend
