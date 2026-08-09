# mcp-security spec delta

## ADDED Requirements

### Requirement: RepoSecretRedactionAtTheToolOutputBoundary

Tool results that carry raw repository content (function bodies, clone snippets, env-var
read sites, search excerpts) SHALL pass through a shared, deterministic secret-redaction
module at the output boundary before reaching the calling agent. Matched spans SHALL be
replaced with typed markers, and every redaction SHALL be disclosed in the result
("N spans redacted", with kinds) — never a silent rewrite, so a consumer knows the content
is not byte-exact. The pass SHALL be pattern-based and reproducible (no entropy scoring, no
learned model), default-on, and opt-out via configuration for trusted-solo use. This extends
*Secret Confinement Across All Output Paths* from the tool's own credentials to the analyzed
repository's content.

#### Scenario: A hardcoded credential does not reach the model verbatim

- **GIVEN** an analyzed repository whose source contains a hardcoded API key
- **WHEN** `get_function_body` (or a search/clone/env-impact tool) returns the containing code
- **THEN** the key's span is replaced with a typed marker and the result discloses the
  redaction count — the raw value never enters the agent's context

#### Scenario: Redaction is disclosed, never silent

- **GIVEN** any tool result in which the redaction pass matched at least one span
- **WHEN** the result is returned
- **THEN** it carries an explicit redaction disclosure; a result with no disclosure is
  guaranteed byte-exact to the source

#### Scenario: A trusted-solo operator can opt out

- **GIVEN** the redaction opt-out set in `.openlore/config.json`
- **WHEN** a source-carrying tool returns content
- **THEN** the content is verbatim and no redaction disclosure is emitted

### Requirement: LlmLogRedactionCoversPromptsAndResponses

The persisted LLM request log SHALL apply the same shared redaction module to BOTH the
request prompts and the response content before an entry is stored, and each log entry SHALL
record its redaction count so a scrubbed log is distinguishable from a clean one. The
gitignored status of the log directory bounds the exposure to local disk but SHALL NOT be
treated as a substitute for redaction.

#### Scenario: An echoed secret is not persisted

- **GIVEN** an LLM interaction whose response echoes a secret present in the prompt's source
  context
- **WHEN** the request log is written to `.openlore/logs/`
- **THEN** the secret is redacted in both the stored prompt and the stored response, and the
  entry records the redaction count

#### Scenario: One module, two surfaces

- **GIVEN** the tool-output boundary and the LLM log path
- **WHEN** either applies redaction
- **THEN** both resolve to the single shared pattern module — a pattern added for one
  surface protects the other without duplication
