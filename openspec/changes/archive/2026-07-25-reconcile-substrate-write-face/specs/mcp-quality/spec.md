# mcp-quality spec delta

## ADDED Requirements

### Requirement: DefaultSurfaceCopyMatchesItsContents

Every published description of a tool preset — the `instructions` breadth pointer, CLI `--help`,
README, docs, and CLAUDE.md — SHALL match the preset's actual contents. A preset SHALL NOT be
described as carrying a capability face (per the closed capability-family taxonomy) unless it
contains that face's tools; in particular, a preset holding only governance *reads* (`recall`,
`verify_claim`, `blast_radius`) SHALL be described as "the navigation core plus governance reads,"
never as "both faces of the substrate," while it lacks the write face (`remember`,
`record_decision`). Copy naming the active default preset SHALL name the preset the code actually
resolves (`LEAN_DEFAULT_PRESET`). The corrected claims SHALL be guarded (per
QuantitativeDocClaimsAreGuarded and the honesty-contract pattern) so the retired phrasing cannot
reappear while the contents are unchanged. Any change to the default preset's contents SHALL
follow the evidence-gated default process (the ADR-0023 precedent): a benchmark run on the
candidate surface, a flip only on no-regression evidence, and a superseding recorded decision.

#### Scenario: A reads-only default is described honestly

- **GIVEN** the `substrate` preset containing the navigation core plus `recall`, `verify_claim`,
  and `blast_radius`, and no `remember` or `record_decision`
- **WHEN** any shipped surface (instructions channel, `--help`, README, docs) describes the
  default surface
- **THEN** it states the preset carries the navigation core plus governance reads
- **AND** it does not claim the preset carries both faces of the substrate

#### Scenario: The declared default matches the resolved default

- **GIVEN** `LEAN_DEFAULT_PRESET` resolving a bare `openlore mcp` to the `substrate` preset
- **WHEN** the `--preset` help or any doc names the default surface
- **THEN** it names `substrate`, not a previously-shipped default retired by a superseding
  decision

#### Scenario: The write face is added only on benchmark evidence

- **GIVEN** a proposal to add the write face (`remember` + `record_decision`) to the default
  `substrate` preset
- **WHEN** the change is evaluated
- **THEN** the DefaultSurfaceRevealsAllFaces benchmark harness is run on the candidate surface
  against the current default, across both models and both repo tiers
- **AND** the default flips only on no-regression evidence, recorded as a decision superseding
  the current default's decision (the c79ec7ca/ADR-0023 process)
- **AND** a regression result keeps the reads-only default, with the copy remaining truthful about
  reads-only

#### Scenario: A face claim cannot silently rot

- **GIVEN** the corrected copy and its guard
- **WHEN** a future edit reintroduces a "both faces" claim while the preset still lacks the write
  face
- **THEN** CI fails, naming the surface carrying the over-claim
