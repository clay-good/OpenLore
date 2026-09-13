# verifier spec delta

## ADDED Requirements

### Requirement: RequirementDescriptionIsTheNormativeText

When verification recovers a requirement's description from a spec, it SHALL take the first line of
normative text after the `### Requirement:` heading, skipping provenance lines — an
`**Implementation**:` anchor item and the backtick-only lines directly continuing it, and provenance
blockquotes that open with a label and colon (`> Decision recorded:`, `> Date:`) or hold only a code
span. A line that merely mentions an anchor, a normative line that is only a code span, and a
blockquote carrying normative text SHALL remain the description.

#### Scenario: A provenance line is not the description

- **GIVEN** a requirement whose multi-line implementation anchor or decision blockquote precedes its
  `The system SHALL …` line
- **WHEN** verification parses the spec
- **THEN** the requirement's description is the `The system SHALL …` line

#### Scenario: A normative blockquote is still the description

- **GIVEN** a requirement whose only text is `> The system SHALL quote.`
- **WHEN** verification parses the spec
- **THEN** the requirement's description is that blockquote line
