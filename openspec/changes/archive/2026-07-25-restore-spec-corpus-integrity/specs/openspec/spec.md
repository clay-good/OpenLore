# openspec spec delta

## ADDED Requirements

### Requirement: SpecCorpusContainsOnlyCodeBackedRequirements

Every requirement in `openspec/specs/` SHALL describe behavior that exists in the codebase (or is
an explicitly-marked PROPOSED delta inside a change). A requirement whose subject has no
corresponding implementation, whose scenarios are the generated placeholder template ("valid state
→ expected outcome"), or whose domain links are dead SHALL be treated as corpus corruption and
removed or rewritten — never left to be served to agents as authority. A CI corpus lint SHALL
reject: the vacuous-scenario template, dead intra-corpus links, duplicate requirement names within
a domain, and a domain table entry with no spec file on disk. Decision-synced requirements SHALL
have one canonical copy in the domain that owns the decision's subject; other domains reference it
by pointer rather than duplicating the text.

#### Scenario: A phantom requirement cannot survive review

- **GIVEN** a spec requirement mandating behavior with no implementing symbol in `src/`
  (e.g. JWT bearer validation in a product with no HTTP auth)
- **WHEN** the corpus lint runs in CI
- **THEN** the build fails identifying the requirement and its domain

#### Scenario: The overview describes the product that exists

- **GIVEN** `openspec/specs/overview/spec.md`
- **WHEN** an agent loads it at session start via CLAUDE.md
- **THEN** its purpose, domain table, and architecture describe OpenLore's current substrate, every
  domain link resolves, and no generated placeholder text remains

#### Scenario: A synced decision lives in one domain

- **GIVEN** an approved decision whose subject is the MCP tool surface
- **WHEN** the decision is synced into the spec corpus
- **THEN** exactly one domain carries the requirement text and any other domain that needs it
  carries a one-line pointer, so a later edit cannot fork the copies
