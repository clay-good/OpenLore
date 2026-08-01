# analyzer spec delta

## ADDED Requirements

### Requirement: PreflightCapacityEstimate

Before the heavy analysis passes, the analyzer SHALL derive a cheap estimate of the memory the
analysis will need from the repository's own size (file count and total bytes, already produced by
the repository mapper). The estimate SHALL be used to choose the memory strategy up front — full
fidelity when it fits, the degradation ladder when it does not — rather than discovering the ceiling
by failing partway through.

The estimate SHALL be conservative and deterministic given the repository: the same repository
yields the same estimate, so the strategy chosen is reproducible for a given memory budget.

#### Scenario: A repository that fits runs at full fidelity

- **GIVEN** a repository whose estimated need is within the available heap
- **WHEN** analysis starts
- **THEN** the full-fidelity path runs and nothing is degraded or disclosed

#### Scenario: An over-capacity repository is detected before the heavy passes

- **GIVEN** a repository whose estimated need exceeds the available heap
- **WHEN** analysis starts
- **THEN** the reduced-fidelity path is chosen up front, not reached by a crash

### Requirement: GracefulMemoryDegradationLadder

When full-fidelity analysis will not fit the available heap, the analyzer SHALL shed work in a
defined, documented order — most expensive and least essential first (the CFG/def-use overlay, then
deep-analysis breadth, then further tiers as defined) — and still produce a usable index, rather than
abort. A raw out-of-memory fatal SHALL NOT be the user-visible outcome of an over-capacity repository
on a machine that can hold the reduced tier.

Whatever the ladder reduces SHALL be disclosed: recorded in the artifact through the existing
parse-health / exclusion disclosure machinery, and surfaced in one CLI line. The disclosure SHALL be
specific enough that a downstream conclusion treats the reduced content as reduced, never as a
genuine structural absence.

#### Scenario: An over-capacity repository still produces a usable index

- **GIVEN** a repository too large for full fidelity but within the reduced tier
- **WHEN** it is analyzed
- **THEN** a working index is produced (call graph and search intact), the overlay/deep-analysis
  tiers are shed in the defined order, and the reduction is disclosed in the artifact and in one line

#### Scenario: Reduced coverage is never read as genuine absence

- **GIVEN** an analysis that shed a tier under memory pressure
- **WHEN** a conclusion is served over the resulting index
- **THEN** the disclosure lets the conclusion distinguish "reduced under memory pressure" from
  "structurally absent", the same way an excluded-file boundary does today

### Requirement: MemoryManagementIsArtifactNeutral

Memory-management decisions that are NOT degradation — the chosen heap size, and any buffer-versus-
spill choice such as the CFG overlay's in-memory-then-overflow behavior — SHALL NOT change the
produced artifact. Two full-fidelity runs of the same repository SHALL yield byte-identical
artifacts regardless of how much memory each machine had.

Only the degradation ladder may reduce content, and only as a function of *declared* constraints
(available memory and repository size). A reduction under the same declared constraints SHALL be
reproducible; there SHALL be no silent, machine-dependent difference between two runs that both ran
at full fidelity.

#### Scenario: Same repository, different machines, identical full-fidelity artifact

- **GIVEN** two machines with different amounts of RAM, both able to analyze a repository at full
  fidelity
- **WHEN** each analyzes the same repository at the same revision
- **THEN** the produced artifacts are byte-identical — heap size and spill decisions did not leak
  into the output

#### Scenario: Degradation is a function of declared constraints, not chance

- **GIVEN** two runs of the same repository under the same declared memory budget
- **WHEN** both must degrade
- **THEN** they shed the same tiers and disclose the same reduction
