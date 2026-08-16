# llm spec delta

## ADDED Requirements

### Requirement: StructuredOutputShapeValidation

Any pipeline that parses structured (JSON) LLM output and then dereferences fields SHALL
validate the response's shape before use — via the schema-checked completion path or
equivalent per-element guards covering every field the code dereferences. A
syntactically-valid but field-incomplete element SHALL be skipped with a counted disclosure
("skipped N malformed entries"), never crash the run with a TypeError and never be silently
dropped while the disclosure is omitted. Valid elements in the same response SHALL survive a
malformed sibling.

#### Scenario: A field-incomplete element does not kill the run

- **GIVEN** a decisions extraction response that parses as JSON but where one element lacks
  `affectedFiles`
- **WHEN** the extractor processes the response
- **THEN** the malformed element is skipped, the skip is disclosed with a count, and the
  remaining well-formed decisions are extracted normally

#### Scenario: Shape guards cover what the code dereferences

- **GIVEN** the set of fields the extractor and consolidator dereference on parsed elements
- **WHEN** an element is accepted for use
- **THEN** every dereferenced field has been shape-checked (present and of the expected
  type), so no unchecked LLM output reaches a property access

### Requirement: TruncatedOutputIsDisclosedNotEmpty

When a structured-output response was truncated by the output-token cap
(`finishReason === 'length'`, or an unparseable response at the cap), the consuming pipeline
SHALL report an explicit truncation outcome — naming the cap and the remedy ("raise the cap
or reduce scope") and stating that results may have been lost — and SHALL NOT return the
empty fallback as if the model had found nothing. The "returned 0 decisions" style of warning
SHALL be reserved for well-formed, genuinely-empty responses.

#### Scenario: A truncated consolidation is not "0 decisions"

- **GIVEN** a consolidation response cut off mid-array at the configured token cap
- **WHEN** parsing fails on the truncated text
- **THEN** the run reports "response truncated at N tokens — decisions may be lost; raise the
  cap or reduce scope", and does not emit the genuinely-empty "returned 0 decisions" warning

#### Scenario: A genuinely empty response still reads as empty

- **GIVEN** a well-formed response containing an empty array and a `stop` finish reason
- **WHEN** the consolidator processes it
- **THEN** the existing "returned 0 decisions" warning is emitted, with no truncation claim
