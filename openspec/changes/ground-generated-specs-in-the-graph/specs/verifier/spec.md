# verifier spec delta

## ADDED Requirements

### Requirement: RequirementDescriptionIsTheNormativeText

When verification recovers a requirement's description from a spec, it SHALL take the first line of
normative text after the heading, skipping provenance lines — an implementation anchor and its
continuation lines, and blockquote lines such as `> Decision recorded:` — and it SHALL recover
requirements at both the `### Requirement:` and the nested `#### Requirement:` heading levels.

#### Scenario: A provenance line is not the description

- **GIVEN** a requirement whose implementation anchor or decision blockquote precedes its
  `The system SHALL …` line
- **WHEN** verification parses the spec
- **THEN** the requirement's description is the `The system SHALL …` line

#### Scenario: Sub-component requirements are recovered

- **GIVEN** a spec with a `#### Requirement:` block under a sub-component
- **WHEN** verification parses the spec
- **THEN** that requirement is recovered with its normative description
