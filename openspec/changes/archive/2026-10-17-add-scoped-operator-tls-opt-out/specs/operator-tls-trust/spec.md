## Purpose

Defines which principal may relax TLS certificate verification for OpenLore's outbound
requests, and over which network surface that relaxation extends. Verification protects
operator credentials and repository source text in transit, so waiving it is a decision that
belongs to the operator alone, and only ever for the surface that actually needs it.

## ADDED Requirements

### Requirement: TlsOptOutIsOperatorSuppliedOnly

A TLS certificate-verification opt-out SHALL be honoured only when it originates from the
operator running the command — a command-line flag or the process environment. A value read
from the analyzed repository's own configuration SHALL NOT relax verification, whatever
spelling it uses, and SHALL be refused with a message naming the operator-supplied
alternative.

#### Scenario: The analyzed repository cannot waive verification

- **GIVEN** a repository whose committed configuration disables TLS verification for the LLM
  or the embedding endpoint
- **WHEN** any command analyzes that repository
- **THEN** certificate verification remains enabled, and the refusal names the flag or
  environment variable an operator would use to opt out deliberately

#### Scenario: The operator's environment is honoured where no flag can reach

- **GIVEN** an operator who set the opt-out for a surface in their environment
- **WHEN** that surface's requests are issued from a context that parses no command line,
  such as the long-running MCP daemon or a git hook
- **THEN** verification is relaxed for those requests

### Requirement: TlsOptOutIsScopedToOneSurfaceWithNoUnionSwitch

Each TLS opt-out SHALL name exactly one network surface — LLM provider requests, or embedding
requests — and SHALL NOT affect the other. The system SHALL NOT provide a single switch that
relaxes every surface at once: an internal self-signed endpoint on one surface is not evidence
about the certificate presented by the other.

#### Scenario: Relaxing embeddings leaves LLM verification intact

- **GIVEN** an operator who opted out of verification for embedding requests only
- **WHEN** an LLM provider request is issued in the same process
- **THEN** that request still verifies the provider's certificate

#### Scenario: Relaxing the LLM leaves embedding verification intact

- **GIVEN** an operator who opted out of verification for LLM requests only
- **WHEN** an embedding request is issued in the same process
- **THEN** that request still verifies the embedding endpoint's certificate

#### Scenario: An unrecognised value fails closed

- **GIVEN** a surface's opt-out variable set to a value that is not an accepted affirmative
- **WHEN** requests on that surface are issued
- **THEN** certificate verification remains enabled

### Requirement: TlsOptOutIsAnnouncedAndBoundedInTime

An honoured opt-out SHALL be announced to the operator, and the relaxation SHALL be scoped to
the individual requests it covers rather than left in force for the lifetime of the process.

#### Scenario: A long-running daemon does not stay unverified

- **GIVEN** a long-running process that issues one request under an honoured opt-out
- **WHEN** that request has completed
- **THEN** certificate verification is back in force for subsequent unrelated requests

### Requirement: DiagnosticsReflectTheOptOutTheRealPathUses

A connectivity diagnostic SHALL evaluate an endpoint under the same TLS decision and the same
configuration precedence as the code path that actually issues the requests, so that a working
setup is never reported as broken.

#### Scenario: Doctor agrees with the real path on a self-signed endpoint

- **GIVEN** an operator-supplied opt-out and an endpoint presenting a self-signed certificate
- **WHEN** the connectivity diagnostic runs
- **THEN** it reports the endpoint reachable, matching what the real request path does

#### Scenario: Doctor reports on the settings actually in effect

- **GIVEN** an environment-selected endpoint, where the real path reads its model and
  credential from the environment and ignores the repository configuration
- **WHEN** the connectivity diagnostic runs
- **THEN** it exercises the environment's values, not the configuration's
