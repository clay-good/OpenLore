## ADDED Requirements

### Requirement: Analysis corpus and domain eligibility are distinct

The analyzer SHALL classify analyzed files independently from their eligibility to define a specification domain. A supporting or domain-excluded file MUST NOT create or independently sustain a domain, while the same file MAY remain available to analysis features that consume its structural or behavioral evidence. A supporting file MUST NOT participate in candidate construction, naming, promotion, cohesion measurement, or independent-boundary decisions; it MAY be attached only after final domains exist.

#### Scenario: Tests remain evidence without minting a domain

- **GIVEN** production files for a `generator` module and tests under its implementation tree
- **WHEN** the repository is analyzed
- **THEN** the tests remain available as supporting evidence for `generator` but no test-only domain is emitted

#### Scenario: Unattached test is disclosed without a fallback domain

- **GIVEN** an analyzed test whose path and imports identify no final domain owner
- **WHEN** supporting evidence is attached after domain reconciliation
- **THEN** the test is disclosed as unattached supporting evidence and does not create a fallback domain

#### Scenario: Fixture projects do not become product domains

- **GIVEN** analyzer fixtures containing complete sample applications in several languages
- **WHEN** the repository is analyzed
- **THEN** fixture-only and snapshot-only candidates are excluded from final specification domains even if those files remain available to language analysis

### Requirement: Domain ownership is layout-aware

The analyzer SHALL derive candidate ownership using deterministic rules appropriate to each source-tree layout. Module-oriented trees MUST prefer stable ownership roots over technical leaf directories, while package-oriented trees MUST preserve meaningful business-package detection after removing build-layout and reverse-DNS noise.

#### Scenario: TypeScript technical child belongs to its module

- **GIVEN** TypeScript files under `src/core/generator/stages`
- **WHEN** domain ownership is derived
- **THEN** `generator` is the ownership candidate and `stages` is not emitted as an independent domain solely because it is the deepest directory

#### Scenario: Java business packages remain distinct

- **GIVEN** Java files under `src/main/java/org/example/petclinic/owner` and `src/main/java/org/example/petclinic/vet`
- **WHEN** domain ownership is derived
- **THEN** `owner` and `vet` remain eligible candidates rather than collapsing into `src`, `main`, `java`, `org`, or `petclinic`

### Requirement: Domain candidates are reconciled before emission

The analyzer SHALL combine directory, filename, dependency-cluster, public-boundary, route, and schema signals into one candidate set and SHALL reconcile overlaps before populating `RepoStructure.domains`. Exact duplicates and technical ancestor/descendant candidates MUST NOT be emitted independently unless each candidate has deterministic evidence of independent ownership. Technical-role candidates MUST be resolved by this common reconciliation process and MUST NOT disappear through an additional silent directory denylist after candidate projection.

#### Scenario: Directory and graph signals do not duplicate a domain

- **GIVEN** directory inference and a dependency cluster both identify the same `generator` ownership area
- **WHEN** final domains are produced
- **THEN** one reconciled `generator` domain is emitted with the combined evidence

#### Scenario: Independent nested module is preserved

- **GIVEN** a nested module with its own defining files and an independent public, route, schema, or cohesive structural boundary
- **WHEN** its candidate is reconciled with its ancestor
- **THEN** it remains a distinct domain and the independent-boundary reason is recorded

#### Scenario: Supporting-only graph cluster cannot create a domain

- **GIVEN** a dependency cluster containing only tests, fixtures, snapshots, generated files, or other non-defining evidence
- **WHEN** graph candidates are projected into the repository structure
- **THEN** no final domain is created from that cluster

#### Scenario: Technical child receives an explainable disposition

- **GIVEN** a technical child candidate such as `generator/utils` with no independent ownership boundary
- **WHEN** candidates are reconciled
- **THEN** it is merged into or excluded relative to `generator` with a stable reason code rather than silently removed by a local directory denylist

### Requirement: Domain reconciliation is deterministic and explainable

The analyzer SHALL emit a bounded decision record for every domain candidate with its disposition, stable reason code, and final owner when applicable. Final domain names, memberships, and candidate dispositions MUST be independent of file traversal and graph iteration order.

#### Scenario: Merged technical child names its owner

- **GIVEN** `stages` is merged into the `generator` ownership domain
- **WHEN** `repo-structure.json` is written
- **THEN** its candidate record identifies the merged disposition, the `generator` owner, and a stable technical-child or contained-footprint reason

#### Scenario: Input order does not change domain output

- **GIVEN** identical analyzed files and graph facts presented in different orders
- **WHEN** domain reconciliation runs
- **THEN** the final domains and candidate decision records are byte-stable apart from unrelated timestamps

### Requirement: Domain configuration remains authoritative

The analyzer SHALL apply configured corpus include/exclude rules before domain inference and MUST NOT reintroduce excluded files through dependency-cluster projection. Downstream selection of domains for generation MUST NOT broaden or rewrite the analyzer's inferred domain membership.

#### Scenario: Excluded subtree cannot return through the graph

- **GIVEN** `examples/**` is excluded from analysis and the dependency graph otherwise contains an examples cluster
- **WHEN** repository domains are generated
- **THEN** no file or candidate from that subtree appears in a final domain

### Requirement: Domain consumers share the reconciled result

Standalone generation, MCP workflows, and Pi workflows SHALL consume the same reconciled `RepoStructure.domains` membership. A client MUST NOT independently recreate or broaden domain inference from raw directories or graph clusters.

#### Scenario: Agent and standalone scopes agree

- **GIVEN** an analyzed repository containing merged technical children and supporting tests
- **WHEN** standalone generation and an MCP- or Pi-hosted generation request select the same domain
- **THEN** they receive the same defining and supporting file membership for that domain

## MODIFIED Requirements

### Requirement: Suggestdomainname

The system SHALL suggest a deterministic domain name from the source-tree layout, candidate ownership root, and directory/file evidence. It MUST ignore domain-ineligible files when establishing a name and MUST NOT use one universal leaf-first rule across incompatible project layouts.

#### Scenario: SuccessfulDomainNameSuggestion

- **GIVEN** a source tree with an identified layout and at least one domain-defining file
- **WHEN** domain naming runs
- **THEN** it returns a stable name for the reconciled ownership candidate

#### Scenario: NoDomainNameSuggestion

- **GIVEN** a candidate with no domain-defining file or meaningful ownership segment
- **WHEN** domain naming runs
- **THEN** it returns an explicitly non-promotable result rather than inventing a generation-ready domain from scan order
