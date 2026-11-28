# cli spec delta

## ADDED Requirements

### Requirement: SlimDigestIsPrintedOncePerSession

`openlore analyze` SHALL write a slim digest of at most 12 lines beside the full `CODEBASE.md`.
At the prompt-submitted moment, `orient --inject` SHALL print the slim digest before the task block
on the first prompt of a harness session where both fit in the injection budget, and SHALL NOT
print it again in that session unless what
it names changed (numbers alone do not count) or the session was compacted. The full `CODEBASE.md`
SHALL keep its name and content.

#### Scenario: The first prompt carries the digest

- **WHEN** the first prompt of a session is submitted in an indexed repository
- **THEN** the hook output contains the slim digest followed by the task orientation

#### Scenario: Later prompts stay quiet

- **WHEN** a second prompt is submitted in the same session and the index has not changed
- **THEN** the hook output contains no digest

#### Scenario: No session identity

- **WHEN** the hook payload has no `session_id`, or `contextInjection.mode` is `off`
- **THEN** no digest is printed

#### Scenario: A repository with no spec framework

- **WHEN** the slim digest is written for a repository with no specs and no decisions
- **THEN** it has no spec or decision line and names no spec framework

### Requirement: PluginSkillsAreFewShortAndCallable

The Claude Code plugin SHALL ship exactly five skills: `openlore-orient`, `openlore-debug`,
`openlore-review-changes`, `openlore-write-tests`, and `openlore-implement-story`. Each `SKILL.md`
SHALL be 80 lines or fewer, SHALL name only OpenLore tools that both the `plugin` preset and the
preset the plugin's `.mcp.json` wires expose, and SHALL be byte-identical to the canonical file
under `skills/`.

#### Scenario: A skill names a tool the plugin does not expose

- **WHEN** a plugin skill names a tool outside the `plugin` preset
- **THEN** the skill guard test fails

#### Scenario: The plugin copy drifts from the canonical skill

- **WHEN** `plugin/skills/openlore-debug/SKILL.md` differs from `skills/openlore-debug/SKILL.md`
- **THEN** the skill guard test fails

### Requirement: SlimDigestIsExactOrAbsent

The slim digest SHALL be printed only when it is byte-for-byte what `openlore analyze` writes, an
index exists on this machine, and the index was not imported. Every fact line SHALL follow a fixed
grammar of numbers, plain names, plain paths, and registered languages. A stale slim digest SHALL
be written by every path that publishes a full analysis (CLI, MCP, API), and a slim digest that is
not current SHALL be rebuilt or removed rather than served.

#### Scenario: A committed file with prose is refused

- **GIVEN** a repository that commits a `CODEBASE.slim.md` whose fact line holds a sentence
- **WHEN** the first prompt of a session is submitted
- **THEN** no digest is printed

#### Scenario: No index on this machine

- **GIVEN** a well-formed `CODEBASE.slim.md` and no `llm-context.json`
- **WHEN** the first prompt of a session is submitted
- **THEN** no digest is printed

#### Scenario: A compaction

- **GIVEN** the digest was printed earlier in the session
- **WHEN** the session is compacted and the next prompt is submitted
- **THEN** the digest is printed again
