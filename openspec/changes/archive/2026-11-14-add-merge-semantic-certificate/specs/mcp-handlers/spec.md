# mcp-handlers spec delta

## ADDED Requirements

### Requirement: MergeSemanticCompatibilityIsCertified

The system SHALL provide an opt-in `certify_merge` conclusion tool that, given two refs and their
merge-base, deterministically certifies their structural compatibility: each symbol one side
removed or changed in signature is joined — in both directions — against the direct call edges the
other side added into it; only direct call edges are joined. Each finding SHALL be classified
`incompatible` (severity `error`) or `potentially-incompatible` (severity `warning`) using the same
closed classification rules as public-surface certification — a change that cannot be proven
compatible is `potentially-incompatible`, never silently compatible — and SHALL name the edge and
the rule; the certificate's overall `verdict` and `summary` carry the labels, and the certificate
SHALL name the two refs and the base. The verdict SHALL be presented as a sound lower bound (`no-detected-conflict`, never
"safe"), and the certificate SHALL disclose that calls the other side already had, import edges,
unindexed languages, and dynamic dispatch are not assessed. A ref that cannot be resolved SHALL be
an error, not a certificate. Findings SHALL be emitted under the registered governance finding code
`merge-semantic-conflict`, advisory by default. The tool SHALL cross-reference its siblings:
footprint hazards (in-flight overlap) and the textual merge oracle (will git conflict) versus this
tool (what breaks when git does not).

#### Scenario: Cleanly merging branches are caught disagreeing

- **GIVEN** branch A adds a call to `parseConfig` and branch B adds a required parameter to
  `parseConfig`, with no textual overlap between the branches
- **WHEN** `certify_merge` runs on A and B
- **THEN** the certificate reports the A-call-site × B-signature-change join as `incompatible`
  with the classification rule

#### Scenario: A migrated rename is not a false conflict

- **GIVEN** branch B renames a symbol and updates every caller within B, and branch A adds a
  caller to the old name
- **WHEN** the certificate is computed
- **THEN** only A's new edge is reported, and B's migrated callers produce no finding

#### Scenario: The unprovable is never silently compatible

- **GIVEN** one branch changes a parameter type in a way that cannot be proven wider or narrower
  (an incomparable or untyped change, or a language with no signature classification), and the
  other branch adds a call to that function
- **WHEN** the certificate is computed
- **THEN** the finding is `potentially-incompatible`, with rule `signature-unprovable`

#### Scenario: An unresolvable ref is an error

- **GIVEN** a ref that cannot be resolved
- **WHEN** the certificate is requested
- **THEN** the tool returns an error and no certificate
