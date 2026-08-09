# llm spec delta

## ADDED Requirements

### Requirement: UntrustedRepoContentIsDelimitedAsData

Every LLM prompt that embeds repository-derived content (git diffs, commit messages,
source excerpts, spec text) SHALL wrap that content in an unforgeable per-request boundary
and SHALL instruct the model that content within the boundary is data to analyze, never
instructions to follow. Forgeable fixed delimiters (`=== path ===`, a markdown code fence)
SHALL NOT be the sole boundary. All analysis call sites SHALL share one boundary helper so
a hardening applied for one path protects the others.

#### Scenario: An embedded instruction does not steer the analysis

- **GIVEN** a git diff that contains text instructing the model to suppress a finding or
  fabricate one
- **WHEN** the decision-extraction, drift, or verification path builds its prompt
- **THEN** the diff is enclosed in the per-request boundary and the model is directed to
  treat it as data; the injected instruction does not change the classification of a
  genuine finding

### Requirement: AnalysisProvidersRunToolDisabled

When OpenLore invokes a tool-capable agent CLI (`claude`, `gemini`, `cursor-agent`) for a
non-interactive analysis call, it SHALL spawn the provider with tools disabled or a
restricted permission mode — these calls require only text in and structured text out. A
provider whose current interface offers no such flag SHALL be refused with a disclosed
message rather than run under the user's tool allowlist.

#### Scenario: A hostile diff cannot drive tool actions

- **GIVEN** a repo whose diff embeds instructions to read files or run shell commands, and
  a user whose agent-CLI allowlist would permit them
- **WHEN** the analysis path spawns the agent CLI provider
- **THEN** the provider runs with tools disabled, so the injected instructions cannot
  execute in the user's environment
