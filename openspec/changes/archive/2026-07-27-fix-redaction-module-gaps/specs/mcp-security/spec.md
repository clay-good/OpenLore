# mcp-security spec delta

## ADDED Requirements

### Requirement: AuthorizationHeaderRedactionConsumesTheFullValue

Secret redaction SHALL replace the ENTIRE value of an `Authorization` header — the scheme
and everything after it, to the end of the line or value — for every authentication scheme,
not only schemes whose credential is a single token. After redaction, no part of the
original header value (scheme argument, base64 credential pair, digest parameters) SHALL
remain in the output.

#### Scenario: Basic credentials are fully redacted

- **GIVEN** text containing `Authorization: Basic dXNlcjpzZWNyZXQ=`
- **WHEN** the string passes through secret redaction
- **THEN** the output contains `Authorization: [REDACTED]` and the base64 credential pair
  appears nowhere in the output

#### Scenario: Any scheme with a spaced credential is covered

- **GIVEN** text containing a `Digest` (or custom-scheme) Authorization header with
  parameters after the scheme
- **WHEN** the string passes through secret redaction
- **THEN** the full header value is replaced, leaving no credential parameters

#### Scenario: Surrounding lines are untouched

- **GIVEN** a multi-line string with an Authorization header on one line
- **WHEN** the string passes through secret redaction
- **THEN** only that header's value is consumed; the following lines are unchanged

### Requirement: CycleSafeRedactionNeverReturnsUnredactedInput

The deep redaction walker SHALL never place an object from the ORIGINAL input graph into
its output: on re-encountering an already-visited object it SHALL resolve to that object's
redacted twin (or an explicit cycle placeholder), preserving termination without leaking an
un-scrubbed subtree. The stated contract — the output is a redacted copy — SHALL hold for
cyclic inputs, which are precisely the inputs the cycle guard exists to handle.

#### Scenario: A cyclic payload is redacted throughout

- **GIVEN** an object graph `a → b → a` where `b` carries a secret-named field
- **WHEN** the graph passes through deep redaction
- **THEN** the walker terminates, the secret value appears nowhere in the output, and no
  node of the output is reference-identical to a node of the input

#### Scenario: The cycle's shape is not a lie

- **GIVEN** the same cyclic input
- **WHEN** the redacted output is produced
- **THEN** the back-reference resolves to the redacted twin or an explicit `[CYCLE]`
  placeholder — never silently to the original object
