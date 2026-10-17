## 1. Domain evidence classification

- [x] 1.1 Add typed domain roles (`defining`, `supporting`, `excluded`) and stable candidate disposition/reason-code types to the analyzer artifact model.
- [x] 1.2 Implement a deterministic file-role classifier that preserves the current exclusion of tests from candidate and graph-cluster formation, but reintroduces analyzed tests as supporting inputs to a separate post-reconciliation attachment pass; prevent fixtures, snapshots, generated trees, sample projects, vendored content, and OpenLore-managed artifacts from defining domains.
- [x] 1.3 Add focused tests proving tests do not influence candidate naming, promotion, cohesion, or independent-boundary decisions while remaining available as attached behavioral evidence; also prove corpus include/exclude rules run first and excluded files cannot re-enter through graph projection.

## 2. Layout-aware ownership candidates

- [x] 2.1 Establish one explicit responsibility boundary for technical names: retain `DOMAIN_NOISE_DIRS` only as path-layout grammar, remove `ArtifactGenerator.generateDomains`' local `skipDirs`, and represent its technical-role semantics as candidate signals with stable reason codes.
- [x] 2.2 Refactor domain naming to select a layout strategy per source tree instead of applying the current leaf-first rule universally.
- [x] 2.3 Implement module-oriented ownership roots so nested technical directories such as `src/core/generator/stages` and `src/cli/commands` attach to `generator` and `cli`.
- [x] 2.4 Preserve package-oriented Java/Kotlin business-package behavior and add mixed/polyglot fixtures demonstrating per-tree strategy selection.
- [x] 2.5 Convert directory, filename-prefix, dependency-cluster, route, schema, public-entry, and contextual technical-role evidence into signals on one normalized candidate model.

## 3. Candidate reconciliation

- [x] 3.1 Implement deterministic exact-duplicate and ancestor/descendant reconciliation over domain-defining footprints.
- [x] 3.2 Merge technical or contained child candidates into their ownership root while retaining genuinely independent nested modules with public, route, schema, or cohesive structural boundaries.
- [x] 3.3 Implement a distinct post-reconciliation pass that attaches supporting tests to an existing owner through deterministic path/import relationships, discloses unattached tests, and never creates a supporting-only fallback domain.
- [x] 3.4 Add order-randomized regression tests proving final names, memberships, ownership links, and reason codes do not depend on traversal or graph iteration order.
- [x] 3.5 Add a structural regression test that fails if a second silent post-projection directory denylist is introduced alongside the path grammar and explainable candidate reconciler.

## 4. Artifact and consumer coherence

- [x] 4.1 Extend `repo-structure.json` with a bounded candidate-decision audit trail and report raw candidate count separately from final generation-ready domain count.
- [x] 4.2 Preserve the existing undomained honesty invariant by disclosing unattached analyzed sources together with their domain role.
- [x] 4.3 Update `llm-context.json`, `CODEBASE.md`, summaries, and domain evidence construction to consume only reconciled final domains while retaining attached supporting evidence.
- [x] 4.4 Add standalone, MCP, and Pi parity tests proving all three surfaces observe identical domain names and file memberships without client-side re-inference.

## 5. Verification and migration safety

- [x] 5.1 Add representative TypeScript, Java/Kotlin, and polyglot integration fixtures covering technical layers, nested business modules, tests, fixtures, snapshots, and generated content.
- [x] 5.2 Re-run analysis on OpenLore itself and record a before/after report showing that fixture-only and technical-leaf domains disappear while major ownership areas remain.
  - Before: 94 user-observed domains prior to reconciliation. After (2026-08-10, final implementation): 129 raw candidates reconcile to 34 final domains over 882 analyzed files; defining membership is unique (424 memberships / 424 unique files). `stages`, `commands`, `fixtures`, `snapshots`, `utils`, and `helpers` are absent as final domains, while `analyzer`, `api`, `cli`, `drift`, `generator`, `mcp-handlers`, `verifier`, and `viewer` remain.
- [x] 5.3 Verify analysis never deletes or renames existing OpenSpec specifications when inferred domains change, and that Generate/Repair reports the resulting reconciliation need.
- [x] 5.4 Run analyzer, artifact, generation, MCP, and Pi test suites, then validate this OpenSpec change strictly.
