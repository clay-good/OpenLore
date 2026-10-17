## ADDED Requirements

### Requirement: TlsOptOutVariablesAreSurfaceScopedAndDocumented

The configuration surface SHALL expose one TLS certificate-verification opt-out variable per
network surface — one for LLM provider requests and one for embedding requests — and SHALL NOT
expose a variable that relaxes both. Each SHALL be documented alongside the certificate-
authority mechanism that is preferred over it, which makes certificates verify rather than
skipping the check.

#### Scenario: Each surface has its own documented variable

- **GIVEN** the documented environment-variable contract
- **WHEN** an operator looks for how to reach an endpoint with a self-signed certificate
- **THEN** they find a variable scoped to that surface alone, and the preferred
  certificate-authority alternative described alongside it

### Requirement: HalfConfiguredRemoteEmbeddingIsDisclosed

A remote embedding endpoint requires both its base URL and its model name. When exactly one of
them is supplied, the system SHALL disclose the incomplete configuration rather than proceed
silently, and SHALL continue serving the keyword index.

The disclosure SHALL name the missing variable. It SHALL NOT describe the keyword index as a
degraded fallback, which would contradict
`KeywordIndexIsAFirstClassDefaultNotADegradedFallback`.

#### Scenario: A base URL with no model name is reported

- **GIVEN** an environment supplying the remote embedding base URL but not the model name
- **WHEN** the embedding provider is resolved
- **THEN** a message names the missing model variable, and the keyword index serves queries

#### Scenario: A fully unconfigured environment stays silent

- **GIVEN** an environment supplying neither variable
- **WHEN** the embedding provider is resolved
- **THEN** no message is emitted, because that is the ordinary default rather than a mistake
