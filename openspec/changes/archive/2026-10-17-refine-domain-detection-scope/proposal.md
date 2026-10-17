## Why

OpenLore currently reports dozens of directory- and cluster-derived candidates as specification domains, including technical layers, nested implementation folders, fixtures, and test-only clusters. This makes domain-scoped generation expensive and misleading even when repository exclusions are configured correctly.

## What Changes

- Separate the analysis corpus from domain eligibility: tests, currently excluded from domain inference and cluster-based domain formation, are reintroduced only after candidate reconciliation as supporting behavioral evidence attached to an existing domain. They never participate in naming, promotion, cohesion, or domain creation. Fixtures, snapshots, generated examples, and vendored sample projects remain excluded from domain inference.
- Reconcile directory-derived and dependency-cluster candidates into one deterministic hierarchy instead of appending both lists and deduplicating only exact names.
- Classify candidates as business domains, technical components/layers, or excluded evidence; expose only business-domain candidates to generation by default.
- Collapse nested implementation candidates into their nearest eligible owner when they describe the same source footprint, such as `generator` and `generator/stages`.
- Preserve an explicit, inspectable explanation for every promoted, merged, demoted, or excluded candidate so agents do not have to infer why a file belongs to a domain.
- Keep user configuration authoritative: explicit include/exclude patterns continue to define the analyzed corpus, while domain selection remains a downstream generation scope rather than an inference override.
- Add representative TypeScript and polyglot corpus tests, including repositories containing fixtures, tests, technical layers, and genuinely nested business modules.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `analyzer`: Domain detection will distinguish evidence files from domain-defining files, reconcile overlapping candidates, and emit explainable generation-ready domains.

## Impact

- Affected analysis surfaces include repository walking, domain naming, repository-map clusters, dependency-graph cluster projection, `repo-structure.json`, `llm-context.json`, and analysis summaries.
- Standalone generation, MCP, and Pi continue consuming `RepoStructure.domains`; they benefit automatically from the smaller deterministic domain set without client-specific logic.
- Existing repositories may see domain names merged or removed after re-analysis. No source files or existing OpenSpec specifications are deleted automatically.
- No new LLM dependency or MCP primitive is introduced.
