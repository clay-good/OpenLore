# cli spec delta

## ADDED Requirements

### Requirement: SlimDigestIsPrintedOncePerSession

`openlore analyze` SHALL write a slim digest of at most 12 lines beside the full `CODEBASE.md`.
At the prompt-submitted moment, `orient --inject` SHALL print the slim digest before the task block
on the first prompt of a harness session, and SHALL NOT print it again in that session unless its
content changed. The full `CODEBASE.md` SHALL keep its name and content.

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
SHALL be 80 lines or fewer, SHALL name only OpenLore tools that the `plugin` preset exposes, and
SHALL be byte-identical to the canonical file under `skills/`.

#### Scenario: A skill names a tool the plugin does not expose

- **WHEN** a plugin skill names a tool outside the `plugin` preset
- **THEN** the skill guard test fails

#### Scenario: The plugin copy drifts from the canonical skill

- **WHEN** `plugin/skills/openlore-debug/SKILL.md` differs from `skills/openlore-debug/SKILL.md`
- **THEN** the skill guard test fails
