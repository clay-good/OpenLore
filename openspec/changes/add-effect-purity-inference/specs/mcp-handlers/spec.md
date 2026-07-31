# mcp-handlers spec delta

## ADDED Requirements

### Requirement: EffectClaimsCarryReceiptsAndBoundaries

Effect facts SHALL surface as an additive `effects` field on `orient` relevant functions,
`get_function_skeleton`, and `blast_radius` symbols. The `verify_claim` kind `effect-free`
SHALL return `confirmed` only when the transitive closure proves purity, `refuted` with the
effect-introducing call path as the receipt, or `unverifiable` naming the boundary (external,
unresolved, or dynamic callee) that blocks the proof. The registered advisory finding
`pure-annotation-contradicted` SHALL fire only when a purity-annotated call target has a
provably non-pure closure effect, citing the effect path — never on `unknown`.

#### Scenario: A purity claim is refuted with a path

- **GIVEN** a function whose resolved callee chain reaches a file-system write
- **WHEN** `verify_claim` runs with kind `effect-free` on that function
- **THEN** the verdict is `refuted` and the receipt names the call path to the I/O site

#### Scenario: Unknown never accuses

- **GIVEN** a `#__PURE__`-annotated call target whose effect is `unknown` via an external
  callee
- **WHEN** the finding pipeline runs
- **THEN** no `pure-annotation-contradicted` finding is emitted, and an `effect-free` claim on
  it returns `unverifiable` naming the external boundary
