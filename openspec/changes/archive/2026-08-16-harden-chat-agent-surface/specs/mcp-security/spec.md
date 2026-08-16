# mcp-security spec delta

## ADDED Requirements

### Requirement: ChatToolResultsCrossTheInjectionBoundary

Tool-result content entering the chat agent's provider prompts — file contents, search
snippets, and other repo-derived data — SHALL receive the same prompt-injection boundary
treatment as repo-derived content in the generate pipeline: source-tagged and
boundary-delimited so instructions embedded in analyzed code are presented as data, not as
directives to the model. The chat surface SHALL NOT be an exception to the injection
boundary the generate pipeline enforces.

#### Scenario: Repo content with embedded directives is delimited

- **GIVEN** a repository file containing text shaped like instructions to an assistant
- **WHEN** a chat tool returns that file's content and the agent sends the next provider
  request
- **THEN** the tool result is carried inside the injection boundary (source-tagged,
  delimited as data), not spliced as bare prompt text

#### Scenario: Boundary parity with the generate pipeline

- **GIVEN** the shared injection-boundary mechanism used by the generate pipeline
- **WHEN** the chat agent forwards any tool result to a provider
- **THEN** the same mechanism is applied at the chat site, with no chat-specific bypass
