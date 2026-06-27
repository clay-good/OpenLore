# analyzer spec delta

## ADDED Requirements

### Requirement: BicepResourceGraphIngestion

The system SHALL ingest Azure Bicep (`.bicep`) files as part of Infrastructure-as-Code analysis,
projecting them onto the existing `FunctionNode`/`CallEdge`/`ClassNode` primitives via the same
normalized `IacGraph` intermediate used by every other IaC ecosystem. `Bicep` SHALL be a member of the
IaC language set, so it is treated as infrastructure everywhere the system already gates on IaC. This
ingestion SHALL require no change to the graph schema, the MCP tools, or `orient`, and SHALL NOT
evaluate any Bicep artifact (no `bicep build`, no ARM template emit, no Azure or registry access): it is
a static parse only.

Because Bicep resolves bare identifiers against a flat per-file symbol table, resource addresses SHALL
be scoped per file and symbol references SHALL resolve within the declaring file only; the sole
cross-file edges SHALL be explicit local `module` links.

#### Scenario: Bicep declarations become graph nodes

- **GIVEN** a `.bicep` file declaring `param location`, `var prefix`, a
  `resource stg 'Microsoft.Storage/storageAccounts@2023-01-01' = { … }`, a `module net './net.bicep'`,
  and an `output id string = stg.id`
- **WHEN** the repository is analyzed
- **THEN** each declaration is a node tagged `Bicep` (the resource typed `Microsoft.Storage/storageAccounts`
  with its `@version` stripped, the param a `variable`, the var a `value`, the output an `output`, the
  module both a node and a module grouping)

#### Scenario: Dependencies between symbols become edges

- **GIVEN** a resource whose body references another resource by symbol (`keyVaultId: kv.id`), a child
  resource nested inside `stg`'s body (or one declaring a `parent: stg` property), a resource that
  declares `dependsOn: [ otherRes ]`, and an `output` whose value is `stg.id`
- **WHEN** the repository is analyzed
- **THEN** there are dependency edges from the resource to `kv`, from the child resource to its parent
  `stg` (derived from structural nesting, or from an explicit `parent:`/`::` reference), a `depends_on`
  edge from the resource to `otherRes`, and a dependency edge from the output to `stg`, so that depth-1
  reachability over `stg` surfaces every symbol that depends on it

#### Scenario: A local module links cross-file to the resources it deploys

- **GIVEN** a `module net './modules/net.bicep' = { … }` and a `modules/net.bicep` that declares
  `resource vnet 'Microsoft.Network/virtualNetworks@2023-01-01' = { … }`
- **WHEN** the repository is analyzed
- **THEN** the module is a `ClassNode` grouping and there is a cross-file dependency edge from the module
  to `vnet`, while a registry module (`br/public:avm/res/…`) is instead an external node with no
  invented edges

#### Scenario: The same symbol name in two files does not cross-link

- **GIVEN** two `.bicep` files that each declare `param location` and a `resource` that references
  `location`
- **WHEN** the repository is analyzed
- **THEN** each file's resource references only its own file's `location` param (addresses are
  file-scoped), and no edge crosses between the two files

#### Scenario: Dynamic or unresolved references emit no edge

- **GIVEN** a Bicep value that references a symbol which is not declared in the file, or a fully-templated
  module path
- **WHEN** the repository is analyzed
- **THEN** the system emits the declaring node but no dependency edge for the unresolvable reference,
  rather than a speculative or wrong edge

#### Scenario: Detection does not regress incremental watching

- **GIVEN** the incremental watcher, which graphs only a subset of languages and never includes IaC
- **WHEN** Bicep support is added
- **THEN** `.bicep` files are recognized by extension in `detectLanguage` and reach the IaC projection at
  analyze time; editing a `.bicep` file under watch matches the established analyze-time behavior of all
  other IaC files (a full re-analyze picks up changes)
