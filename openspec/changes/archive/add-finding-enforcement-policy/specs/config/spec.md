# config spec delta

## ADDED Requirements

### Requirement: FindingEnforcementPolicyDeclaration

The system SHALL support an optional, additive `enforcement.policy` object in `.openlore/config.json`
that maps a stable governance finding **code** to exactly one enforcement class — `blocking`,
`advisory`, or `off`. The declaration SHALL be optional: an absent, empty, or malformed-but-recoverable
policy SHALL degrade to "no policy declared" (preserving current behavior) rather than throwing. An
unrecognized code in the policy SHALL be retained and SHALL produce a non-failing config finding rather
than an error, so a policy may name a code before its source ships.

#### Scenario: Absent policy preserves current behavior

- **GIVEN** a `.openlore/config.json` with no `enforcement.policy`
- **WHEN** the config is read
- **THEN** the parsed config reports no declared policy, and every finding source keeps its
  source-declared default enforcement

#### Scenario: A declared policy maps codes to classes

- **GIVEN** an `enforcement.policy` mapping `stale-decision-reference` to `blocking` and
  `surface-critical` to `advisory`
- **WHEN** the config is read
- **THEN** the parsed policy resolves those two codes to those two classes, and any code absent from the
  map resolves to its source-declared default

#### Scenario: An unknown code is retained, not rejected

- **GIVEN** an `enforcement.policy` naming a finding code that no installed source emits
- **WHEN** the config is read
- **THEN** the entry is retained and a non-failing config finding notes the unrecognized code, and the
  read does not throw

### Requirement: EnforcementClassResolutionIsDeterministicAndSeverityIndependent

The system SHALL resolve a finding's enforcement class by a pure function of the finding's code, the
declared policy, and the finding's intrinsic severity, with a fixed, order-independent precedence: an
explicit `off` for the code wins over all other entries; otherwise an explicit `blocking` wins; otherwise
an explicit `advisory` wins; otherwise the source-declared default for that code applies. The resolver
SHALL NOT alter or derive the finding's severity — it decides enforcement class only. Identical inputs
SHALL produce identical output regardless of policy declaration order.

#### Scenario: Off silences a finding the source would otherwise block

- **GIVEN** a finding whose source default is `blocking`, and a policy mapping its code to `off`
- **WHEN** the enforcement class is resolved
- **THEN** the class is `off`, the finding's severity is unchanged, and the finding remains available as
  informational output

#### Scenario: Resolution is independent of declaration order

- **GIVEN** two policies with the same code→class entries declared in different orders
- **WHEN** the enforcement class is resolved for the same finding under each
- **THEN** both resolve to the identical class
