# mcp-handlers spec delta

## MODIFIED Requirements

### Requirement: StructuralClaimVerification

`verify_claim` gains a `decision-current` claim kind so an agent about to *cite a decision* to a human can
first check it is still authoritative — the active counterpart to `recall`'s passive
`stale-decision-reference` flag. The kind extends the existing verdict contract from the call graph to the
recorded decision store. Its `subject` is an 8-character decision id (not a symbol). The verdict SHALL be a
pure read of the decision store, sharing the SAME retirement graph the `stale-decision-reference` finding
walks so the two can never disagree about what counts as superseded: `confirmed` when the id resolves to a
recorded decision that is neither superseded nor rejected; `refuted` when it has been superseded (the
reason naming the live terminal superseder to cite instead) or was rejected; `unverifiable` when the id is
malformed or no such decision is recorded in this repository. This kind SHALL verify against the decision
store only and SHALL NOT load or contort the structural call-graph verifier. All prior structural-kind
behavior is unchanged.

#### Scenario: Citing a superseded decision is refuted, naming the superseder

- **GIVEN** a `decision-current` claim about a decision id that a later decision supersedes
- **WHEN** the claim is verified
- **THEN** the verdict is `refuted`, the reason names the live superseding decision to cite instead, and
  the receipt carries the retired decision and its `supersededBy`

#### Scenario: An unknown decision id is unverifiable, not fabricated

- **GIVEN** a `decision-current` claim whose id is well-formed but recorded in no decision in this
  repository
- **WHEN** the claim is verified
- **THEN** the verdict is `unverifiable` (hedge or read the source), never a fabricated `confirmed`

### Requirement: StaleDecisionReferenceSurfacedThroughExistingTools

The deferred `verify_claim` clause is now closed. The `stale-decision-reference` integrity gap SHALL be
surfaced through three existing surfaces, all without a new MCP tool: `recall` flags an authoritative
memory that cites a retired decision (passive); `openlore enforce` contributes the finding to the unified
gate (commit governance); and `verify_claim`'s `decision-current` kind lets an agent affirmatively check a
decision it is *about to cite* (active). All three read supersession from the same decision-store
retirement graph, so they can never disagree.

#### Scenario: verify_claim affirmatively checks a decision an agent is about to cite

- **GIVEN** an agent about to tell a human that decision X governs a change
- **WHEN** it verifies `{ kind: 'decision-current', subject: X }` and X has been superseded
- **THEN** the verdict is `refuted`, naming the superseding decision to cite instead, so the stale citation
  is caught before it reaches the human
