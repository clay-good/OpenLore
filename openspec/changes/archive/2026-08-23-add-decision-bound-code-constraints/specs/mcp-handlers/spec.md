# mcp-handlers spec delta

## ADDED Requirements

### Requirement: EnforcementEligibilityIsDeclaredAndPublishedAsSeparateMeasurements

The system SHALL maintain an eligibility classification for every authoritative decision, with
exactly three states: eligible, meaning the decision's intent reduces to a concrete checkable
repository property; ineligible, which SHALL carry a stated reason; and unclassified, meaning no
judgment has been made. Unclassified SHALL be a valid state, not an error and not a defect.

The system SHALL NOT infer, guess, or bulk-assign an eligibility classification. Classification
SHALL be a declared, reviewable act. An eligible decision carrying no constraints SHALL remain
visible as a coverage gap and SHALL NOT be counted as covered.

Reporting SHALL publish, as four separate measurements that the system SHALL NOT combine into a
single figure: adoption, being the constrained share of all authoritative decisions; coverage,
being the constrained share of eligible decisions; the count of unclassified decisions; and the
count of active rules. Each report SHALL state which measurement is which, so that a reader can
distinguish what is machine-enforced from what is written down.

A decision whose intent is only partly reducible to checkable properties MAY be classified eligible
provided the report states both the enforced boundary and the remainder that still requires human
judgment. The system SHALL NOT present a partially enforced decision as fully enforced.

The classification and the four measurements SHALL be deterministic functions of the corpus and
SHALL be byte-stable across repeated runs over unchanged corpus bytes.

#### Scenario: The four measurements are reported separately

- **GIVEN** a decision corpus containing authoritative decisions in all three eligibility states
- **WHEN** the enforcement report is produced
- **THEN** adoption, coverage, the unclassified count, and the active-rule count each appear as
  their own labelled measurement
- **AND** no single combined enforcement percentage is presented

#### Scenario: Eligibility is never inferred

- **GIVEN** a decision with no declared eligibility classification
- **WHEN** the report is produced
- **THEN** it is counted as unclassified
- **AND** the system does not assign it eligible or ineligible on its behalf

#### Scenario: An eligible decision with no rules stays a visible gap

- **GIVEN** a decision classified eligible that declares no constraints
- **WHEN** coverage is computed
- **THEN** the decision counts toward the eligible denominator and not toward the constrained
  numerator
- **AND** it is listed as a coverage gap

#### Scenario: An ineligible classification states its reason

- **GIVEN** a decision classified ineligible
- **WHEN** the report is produced
- **THEN** the stated reason accompanies the classification
- **AND** a classification without a reason fails validation

#### Scenario: A partially enforceable decision discloses its remainder

- **GIVEN** an eligible decision whose constraints cover only part of its intent
- **WHEN** the report is produced
- **THEN** both the enforced boundary and the human-review remainder are stated
- **AND** the decision is not presented as fully enforced
