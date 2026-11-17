# cli spec delta

## ADDED Requirements

### Requirement: PlanAuthoringPromptsReceivePreparation

At the prompt-submitted moment, the OpenLore prompt hooks (Claude Code `orient --inject`, Pi
`before_agent_start`, Codex `orient --proposal-only`) SHALL print the proposal preparation block
when the submitted prompt is a recognized request to write a plan, spec, or proposal. Recognition
SHALL use a closed, documented list of commands and phrases, and SHALL NOT require OpenSpec or any
other spec framework to be installed. A prompt that is not recognized SHALL be handled exactly as
before.

#### Scenario: A Spec Kit prompt gets the block

- **WHEN** the user submits `/speckit.specify add rate limits` in a repository with no `openspec/` directory
- **THEN** the hook output contains the `[OpenLore proposal preparation]` block
- **AND** the normal task orientation for the prompt is still printed

#### Scenario: A plain-language plan request gets the block

- **WHEN** the user submits "write an implementation plan for the retry queue"
- **THEN** the hook output contains the preparation block

#### Scenario: An ordinary prompt is unchanged

- **WHEN** the user submits "fix the failing spec test"
- **THEN** the hook output contains no preparation block

### Requirement: PlanPreparationKeepsUserIntentAndOrientsFirst

The preparation block SHALL tell the agent to recover the requested outcome, the decisions the user
explicitly accepted, the constraints, and the open questions from the conversation; to ask one
focused question and write no plan or spec files when there is no actionable request; and otherwise
to call `orient` with that brief before it writes. The block SHALL tell the agent to keep unchosen
options as open questions and to disclose when orientation is unavailable. The text SHALL name no
spec framework.

#### Scenario: The block is framework-neutral

- **WHEN** the block is printed for any recognized prompt
- **THEN** it contains no framework name and refers to "plan or spec files"

#### Scenario: Injection is turned off

- **WHEN** `.openlore/config.json` sets `contextInjection.mode` to `off`
- **THEN** no preparation block is printed
