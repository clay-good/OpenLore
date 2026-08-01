# mcp-handlers spec delta

## ADDED Requirements

### Requirement: MergeSemanticCompatibilityIsCertified

The system SHALL provide an opt-in `certify_merge` conclusion tool that, given two refs and their
merge-base, deterministically certifies their structural compatibility: each symbol one side
removed, renamed, or changed in signature is joined — in both directions — against the call and
import edges the other side added or retained into it, with renames resolved through symbol
identity continuity before comparison. Each finding SHALL be classified `incompatible` or
`potentially-incompatible` using the same closed classification rules as public-surface
certification — a change that cannot be proven compatible is `potentially-incompatible`, never
silently compatible — and SHALL carry its receipt: the commits, the edge, and the rule. The
verdict SHALL be presented as a sound lower bound ("no detected incompatibility", never "safe"),
with unresolvable refs, unindexed languages, and dynamic-dispatch boundaries disclosed as
not-assessed. Findings SHALL be emitted under a registered governance finding code, advisory by
default. The tool SHALL cross-reference its siblings: footprint hazards (in-flight overlap) and
the textual merge oracle (will git conflict) versus this tool (what breaks when git does not).

#### Scenario: Cleanly merging branches are caught disagreeing

- **GIVEN** branch A adds a call to `parseConfig` and branch B adds a required parameter to
  `parseConfig`, with no textual overlap between the branches
- **WHEN** `certify_merge` runs on A and B
- **THEN** the certificate reports the A-call-site × B-signature-change join as `incompatible`
  with both commits and the classification rule

#### Scenario: A migrated rename is not a false conflict

- **GIVEN** branch B renames a symbol and updates every caller within B, and branch A adds a
  caller to the old name
- **WHEN** the certificate is computed
- **THEN** only A's new edge is reported, and B's migrated callers produce no finding

#### Scenario: The unprovable is never silently compatible

- **GIVEN** one branch narrows a parameter type used by the other branch's added call
- **WHEN** the certificate is computed
- **THEN** the finding is `potentially-incompatible` with the rule receipt

#### Scenario: What cannot be assessed says so

- **GIVEN** a ref that cannot be resolved or a call within an unindexed language
- **WHEN** the certificate is computed
- **THEN** the affected scope is reported not-assessed, and the overall verdict discloses it
  rather than claiming "no conflict"
