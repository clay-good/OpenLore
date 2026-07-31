# openspec spec delta

## ADDED Requirements

### Requirement: DecisionSyncWritesOneOwningDomain

An approved decision synced into the spec corpus SHALL be written in full to exactly one owning
domain — the first of the decision's `affectedDomains` that resolves to a spec file — with a
one-line pointer reference in each other affected domain. The syncer SHALL NOT append the same
requirement or Decisions block verbatim to every affected domain's spec. This keeps the corpus
free of cross-domain duplicates (for example, MCP-preset requirements must not appear verbatim in
the drift, analyzer, and cli specs).

This requirement governs how OpenLore writes its *own* decision records into the OpenSpec corpus;
it does not add any change-lifecycle command (see
[architecture: SpecDrivenDevelopmentDelegatedToOpenSpec](../architecture/spec.md)).

#### Scenario: A decision is written to one domain with pointers elsewhere

- **GIVEN** an approved decision about the MCP tool surface affecting `mcp-quality`, `drift`, and
  `cli`
- **WHEN** the syncer writes the corpus
- **THEN** the full requirement appears once (in the owning domain, `mcp-quality`) and the other
  affected domains carry a one-line pointer reference only

#### Scenario: Re-syncing does not fan out duplicates

- **GIVEN** a decision that was already synced to its owning domain
- **WHEN** the syncer runs again
- **THEN** no additional verbatim copy is appended to any other domain's spec
