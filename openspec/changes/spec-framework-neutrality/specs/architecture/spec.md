## MODIFIED Requirements

### Requirement: SpecDrivenDevelopmentDelegatedToOpenSpec

OpenLore is a distinct product from OpenSpec and SHALL NOT reimplement OpenSpec's spec-driven-
development lifecycle. OpenSpec (`@fission-ai/openspec`) is OpenLore's first-class spec format and
the framework OpenLore itself is built with: it owns authoring change proposals and the
change→archive lifecycle, folding a change's spec deltas into the main corpus (`openspec archive`),
and listing / validating / showing changes and specs (`openspec list`, `openspec validate`,
`openspec show`, `openspec status`).

OpenLore's product surface SHALL be confined to deterministic, locally-computed structural memory
over code: the call graph, reachability and impact, symbol-anchored memory and decisions, code↔spec
drift detection, and generating OpenSpec-format specs from code. OpenLore therefore:

- SHALL delegate change-lifecycle operations to the OpenSpec CLI and SHALL NOT ship an
  `openlore change`, `openlore archive`, or `openlore validate-changes` command, nor an MCP tool,
  that folds spec deltas or manages the change→archive lifecycle.
- MAY read the OpenSpec corpus and generate OpenSpec-format specs (the integration surface), and
  MAY govern its own decision records within that corpus (see
  [openspec: DecisionSyncWritesOneOwningDomain](../openspec/spec.md)).
- SHALL NOT require an OpenSpec corpus or the `openspec` CLI for any feature. A check that needs
  the CLI SHALL report `not assessed` with the reason when the CLI is absent, and a repository with
  no OpenSpec corpus SHALL still get every answer that is computed from code, tests and decisions.

Every proposed capability SHALL be justified against this boundary: if a capability's value is
change-lifecycle management, it belongs to OpenSpec, not OpenLore.

#### Scenario: A lifecycle capability is delegated, not rebuilt

- **GIVEN** a need to fold a shipped change's spec deltas into the main corpus and archive it
- **WHEN** the work is scoped
- **THEN** it is performed with `openspec archive` and OpenLore adds no equivalent command, fold
  engine, or MCP tool

#### Scenario: A proposal that rebuilds OpenSpec is rejected as out of scope

- **GIVEN** a proposal to add an `openlore change list` / `openlore change archive` surface
- **WHEN** it is reviewed against this requirement
- **THEN** it is rescoped to consume the OpenSpec CLI, retaining only genuinely OpenLore-native
  structural or decision-governance work

#### Scenario: A repository without OpenSpec loses no code answer

- **GIVEN** a repository with no `openspec/` folder and no `openspec` binary on `PATH`
- **WHEN** an agent calls `orient`, `blast_radius`, `verify_change`, `verify_claim` or `recall`
- **THEN** each returns its code, test and decision conclusions
- **AND** no response is an error that names OpenSpec or `openlore generate` as a prerequisite

## ADDED Requirements

### Requirement: SpecSourcesAreReadThroughOneReadOnlyAdapter

OpenLore SHALL read written intent through one local, read-only spec-source interface: detect a
source, then list its items. Each item SHALL carry only `id`, `text`, `file`, `line` and `kind`.
OpenSpec SHALL be the first adapter. Sources SHALL be detected in one fixed order and every detected
source SHALL be read. An adapter SHALL NOT write, create or edit any file of the source it reads.

#### Scenario: The fixed order

- **WHEN** spec sources are detected
- **THEN** they are checked in this order: OpenSpec, Spec Kit, BMAD, ADR folders, markdown
  requirements, tests as intent

#### Scenario: Two sources are present

- **GIVEN** a repository with `openspec/specs/` and a `docs/adr/` folder
- **WHEN** spec sources are detected
- **THEN** both `openspec` and `adr` are reported as found, in that order
- **AND** items from both carry a repo-relative `file` and a 1-based `line`

#### Scenario: A Spec Kit folder is not mistaken for OpenSpec

- **GIVEN** a repository with `.specify/` and `specs/001-login/spec.md` that has no
  `### Requirement:` heading
- **WHEN** spec sources are detected
- **THEN** the source found is `spec-kit`, not `openspec`

#### Scenario: A source without code anchors is not assessed for drift

- **GIVEN** a repository whose only source is BMAD planning files
- **WHEN** a drift, mapping or spec-coverage answer is requested
- **THEN** the answer says it was not assessed because the source has no code anchors
- **AND** it does not report zero drift or zero coverage

#### Scenario: Reading leaves the source untouched

- **WHEN** any adapter lists the items of a source
- **THEN** no file under that source's folders is created, changed or deleted
