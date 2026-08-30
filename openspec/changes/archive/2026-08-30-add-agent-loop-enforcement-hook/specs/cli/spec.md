# cli spec delta

## ADDED Requirements

### Requirement: AgentLoopEnforcementHook

`openlore enforce` SHALL provide an `--agent-hook` mode that emits the same governance finding
set as the commit gate, shaped for the agent loop: a concise, remediation-first rendering on
stderr and an exit-code contract matching Claude Code hook semantics — exit 2 (block, stderr fed
back to the agent) ONLY when at least one finding resolves to `blocking` through
`enforcement.policy`, exit 0 otherwise. Infrastructure failure (a throw, an unavailable source)
SHALL degrade to a caveat and exit 0, never a block. The mode SHALL be wireable into
`.claude/settings.json` by the installer only on explicit request, reusing the existing
corrupt-settings refusal (settings that exist but do not parse are never overwritten). The
existing git pre-commit `--hook` mode and the advisory-by-default doctrine are unchanged.

#### Scenario: A blocking finding stops the turn with an actionable message

- **GIVEN** an `enforcement.policy` mapping a finding code to `blocking` and a working tree
  that triggers that finding
- **WHEN** the agent host runs `openlore enforce --agent-hook` at a Stop/PostToolUse hook
- **THEN** the process exits 2 and stderr leads with the finding's remediation (when its code
  declares one), so the agent can act in the same loop

#### Scenario: No declared policy never blocks the loop

- **GIVEN** a repository with no `enforcement.policy`
- **WHEN** `--agent-hook` runs with advisory findings present
- **THEN** the process exits 0 and the findings render as a one-line-each advisory summary

#### Scenario: Infrastructure failure is a caveat, not a block

- **GIVEN** a finding source that throws (e.g. no analysis cache)
- **WHEN** `--agent-hook` runs
- **THEN** the failure is reported as a caveat and the process exits 0

#### Scenario: The installer refuses to clobber corrupt settings

- **GIVEN** a `.claude/settings.json` that exists but is not valid JSON
- **WHEN** the user requests agent-hook installation via `openlore setup`
- **THEN** the installer refuses with an explanatory error and leaves the file untouched
