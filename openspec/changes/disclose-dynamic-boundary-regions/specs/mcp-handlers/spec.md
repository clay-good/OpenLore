# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ConclusionsDiscloseDynamicBoundariesThroughTheConfidenceBoundaryContract

Dynamic-boundary sites SHALL be disclosed through the **existing confidence-boundary contract**,
not through a new response field: the known-unknowable crossing vocabulary SHALL gain a
`dynamic-boundary` kind carrying the structured sites (file, line, `kind`) in scope, so every
conclusion that already assembles a confidence boundary discloses them without a shape addition.
A conclusion surface that today discloses only free-text caveats SHALL render its disclosure
**from** that structured crossing rather than maintaining a parallel one, and each such surface
SHALL be listed in the change as a shape addition rather than described as unchanged.

Disclosure SHALL be scoped to the subgraph the conclusion traversed, never to the repository. It
SHALL be bounded and deduplicated by kind and file, and a bounded disclosure SHALL carry a
truncation receipt naming the omitted count. A conclusion with no sites in scope SHALL disclose
nothing new.

#### Scenario: A blast radius names the boundary that bounds it

- **GIVEN** a changed symbol whose caller closure includes a file containing a
  `container-resolution` site
- **WHEN** the blast radius is computed
- **THEN** the boundary crossing names that file, line, and kind, and the result is still
  returned

#### Scenario: A clean region stays clean

- **GIVEN** a traversal over a subgraph with no sites, in a repository that has sites elsewhere
- **WHEN** the conclusion is assembled
- **THEN** no dynamic-boundary crossing is attached

#### Scenario: A large boundary set is bounded with a receipt

- **GIVEN** a traversal crossing more sites than the disclosure bound allows
- **WHEN** the conclusion is assembled
- **THEN** the disclosed subset is accompanied by the count of omitted sites

### Requirement: NegativeVerdictsAreQualifiedNearADynamicBoundaryWithoutDoubleDowngrading

A verdict asserting the **absence** of a caller or of risk SHALL be qualified when a dynamic-
boundary site lies in the subject's computable neighborhood.

**Scope is computable, not repository-wide.** A dead-code candidate SHALL be qualified when a
site of kind `reflective-invoke`, `computed-member`, or `container-resolution` occurs in the
candidate's own file, or in a file within the transitive import closure of the candidate's module
— the set of files that can name it — restricted to sites whose language matches the candidate's.
The qualification SHALL name the file and line of the specific site that caused it. Sites outside
that closure SHALL NOT qualify the candidate; the existing whole-repository caveat continues to
carry that case.

**No double downgrade.** Where an existing whole-language or synthesized-dispatch downgrade
already applies, the site-based treatment SHALL NOT lower confidence further; it SHALL instead
**replace the generic caveat with the specific site** as the stated reason, so the reader learns
*which* construct bounds the answer rather than only *that* the language is dynamic. The shipped
language-level cap remains the floor for languages with no matcher. A verdict already
`unverifiable` for another crossing SHALL carry both crossings, never one silently overwriting
the other.

The `also-dead` label in the coverage-gap report SHALL be withheld for a qualified symbol in
favor of the plain gap label. A `dead` or `safe-to-change` claim verified against a qualified
neighborhood SHALL resolve to `unverifiable`, with the boundary named in the receipt.

A boundary SHALL NEVER be used to assert the opposite conclusion: the system SHALL NOT report a
symbol as live, tested, or unsafe merely because a boundary is nearby.

#### Scenario: A boundary in an unrelated module does not qualify

- **GIVEN** a dead-code candidate in a module that no file containing a site can import
- **WHEN** candidates are computed
- **THEN** the candidate's confidence is unchanged and no site is cited as its reason

#### Scenario: The specific reason replaces the generic one

- **GIVEN** a Python dead-code candidate already capped at low confidence by the shipped
  dynamic-language rule, whose file contains a `reflective-invoke` site
- **WHEN** candidates are computed
- **THEN** the confidence is unchanged — not lowered a second time — and the stated reason names
  that site's file and line rather than only "dynamic language"

#### Scenario: Two crossings both survive

- **GIVEN** a `safe-to-change` claim whose subject has both a synthesized-dispatch crossing and a
  dynamic-boundary site
- **WHEN** the claim is verified
- **THEN** the verdict is `unverifiable` and the receipt carries both crossings

#### Scenario: The qualification is one-directional

- **GIVEN** a symbol with a site in its file and no reaching test
- **WHEN** the coverage-gap report is assembled
- **THEN** the symbol is still reported as a gap; the boundary only withholds the `also-dead`
  label and never implies the symbol is tested or reached

### Requirement: DynamicBoundaryFindingIsRegisteredAndAdvisory

A dynamic-boundary crossing inside a conclusion's scope SHALL be emitted as a registered
governance finding with the stable code `dynamic-boundary-in-conclusion-scope` and
`defaultClass: 'advisory'` — the registry's invariant, since blocking is always opt-in. The
finding's `severity` SHALL be carried on the emitted governance finding, never on the registry
entry, and SHALL play no part in classing it.

Emission SHALL occur only where a conclusion qualifies or caps a verdict because of a site, never
for a purely informational disclosure.

#### Scenario: The finding is advisory unless a policy names it

- **GIVEN** a repository with no enforcement policy and a conclusion that capped a verdict at a
  boundary
- **WHEN** the commit gate runs
- **THEN** the finding is reported and the gate does not block; **and WHEN** the policy classes
  the code `blocking`, the gate blocks
