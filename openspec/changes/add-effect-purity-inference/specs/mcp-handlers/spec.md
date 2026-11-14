# mcp-handlers spec delta

## ADDED Requirements

### Requirement: EffectClaimsCarryReceiptsAndBoundaries

Effect facts SHALL surface as an additive `effects` field on the functions that `orient` and
`blast_radius` list. The `verify_claim` kind `effect-free` SHALL return `confirmed` only when the
closure proves purity, `refuted` with the call path to the effect site, or `unverifiable` naming
the callee that blocks the proof. The advisory finding `pure-annotation-contradicted` SHALL fire
only on a proven effect path, never on `unknown`.

#### Scenario: A purity claim is refuted with a path

- **WHEN** `verify_claim` runs with kind `effect-free` on a function whose resolved callees reach a file-system write
- **THEN** the verdict is `refuted` and the receipt names the call path to the I/O site

#### Scenario: Unknown never accuses

- **WHEN** a `#__PURE__`-annotated target has effect `unknown` through an external callee
- **THEN** no `pure-annotation-contradicted` finding is emitted
- **AND** an `effect-free` claim on it returns `unverifiable` naming the external callee

### Requirement: SharedStateUpdatesSplitByASuspensionAreReported

`verify_change` SHALL emit the advisory finding `shared-state-interleaved-update` when a function
the diff touches reads a module-level binding, suspends, and then writes the same binding. The
finding SHALL give the read, suspension and write lines and the other writers of the binding. The
after-edit receipt SHALL carry the finding when the edit introduced the shape. The system SHALL
NOT state that a binding is unshared, race-free or safe, and unsupported languages SHALL produce
no finding.

#### Scenario: An await between read and write is reported with its lines

- **WHEN** the diff adds an `await` between a read and a write of one module binding in a function
- **THEN** `verify_change` reports `shared-state-interleaved-update` with the three lines and the other writers of that binding

#### Scenario: A write through an alias is not claimed absent

- **WHEN** a module binding is written only through an alias the analysis cannot resolve
- **THEN** the writer list omits that write and the answer does not state that the binding has no other writer
