## Context

`RepositoryMapper` currently infers directory domains by walking paths leaf-first. `ArtifactGenerator` then appends dependency-graph clusters as additional domains and removes only exact-name duplicates. This is useful for Java package layouts, but on TypeScript repositories it turns implementation folders (`generator/stages`, `cli/commands`) and fixture projects into independent spec-generation scopes.

Tests are not currently domain evidence: `inferDomains` skips `file.isTest` and `file.isConfig`, and dependency-cluster formation also excludes test nodes. Treating tests as `supporting` therefore deliberately reintroduces them after domain reconciliation; it is not merely a new label for existing domain membership.

Two overlapping filters also exist today. `DOMAIN_NOISE_DIRS` is a path-segment grammar used while deriving names (`src`, `main`, `com`, and similar layout noise), while `ArtifactGenerator.generateDomains` has a separate local `skipDirs` list for technical roles (`utils`, `helpers`, `common`, `shared`, `config`, `middleware`). This change must consolidate their responsibilities rather than add another independent denylist.

The analyzer has two different consumers with different needs. Navigation and code archaeology benefit from tests, fixtures, and fine-grained graph clusters. Spec generation needs a smaller set of stable ownership domains. A single undifferentiated corpus and candidate list cannot serve both honestly.

## Goals / Non-Goals

**Goals:**

- Produce a deterministic, generation-ready domain set that represents stable code ownership rather than every directory or graph cluster.
- Retain tests as behavioral evidence without allowing them to mint domains.
- Prevent fixture, snapshot, sample-project, generated, tooling, and test-only clusters from becoming domains even when those files remain analyzable.
- Reconcile directory and graph signals before emitting `RepoStructure.domains`.
- Preserve genuinely independent nested business modules.
- Explain every promotion, merge, attachment, and exclusion with stable reason codes.
- Keep the same final domain representation available to standalone generation, MCP, and Pi.

**Non-Goals:**

- Inferring business meaning with an LLM.
- Enforcing a universal target number of domains.
- Removing tests or fixtures from every analysis feature.
- Automatically deleting or renaming existing OpenSpec files after domain inference changes.
- Adding a new MCP primitive solely for domain reconciliation.

## Decisions

### 1. Separate corpus inclusion from domain eligibility

Each analyzed file will receive a deterministic domain role:

- `defining`: may create or independently sustain a domain;
- `supporting`: may attach evidence to a domain but cannot create one;
- `excluded`: contributes no domain evidence.

Production source is normally `defining`. Tests are `supporting`. Fixtures, snapshots, generated trees, vendored samples, and OpenLore-managed artifacts are `excluded` from domain inference, even when another analysis surface intentionally retains them. User include/exclude patterns remain authoritative over whether a file enters analysis at all.

Tests remain excluded from candidate construction, naming, graph-cluster promotion, cohesion measurements, and independent-boundary decisions. Only after final domains have been reconciled does a separate association pass attach a test as supporting evidence to an existing owner using deterministic path and import relationships. A test that cannot be attached is disclosed; it never creates a fallback domain.

Alternative considered: add more default `excludePatterns`. Rejected as the complete solution because removing tests and fixtures globally would weaken debugging, language-fixture analysis, and behavioral archaeology while still leaving technical leaf directories over-segmented.

### 2. Use layout-aware ownership roots instead of one leaf-first rule

Domain naming will first identify the project layout:

- module-oriented layouts such as TypeScript/JavaScript use the first stable ownership segment below a source root and optional architectural wrapper (`src/core/generator/stages` → `generator`, `src/cli/commands` → `cli`);
- package-oriented layouts such as Java/Kotlin retain the existing package-aware behavior that skips build-layout and reverse-DNS noise and can identify business packages such as `owner` and `vet`;
- mixed/polyglot repositories apply the rule per source tree, not once globally.

Explicit corpus configuration remains authoritative, and established framework adapters may refine the inferred ownership root. The algorithm remains deterministic and language-aware, not LLM-driven.

Alternative considered: continually expand a global technical-directory denylist. Rejected because names such as `api`, `services`, or `commands` can be legitimate top-level ownership domains in one repository and mere layers in another.

`DOMAIN_NOISE_DIRS` remains the single path-grammar vocabulary for segments that cannot carry ownership meaning in a given layout. It does not itself classify files or final candidates. The local `skipDirs` filter in `ArtifactGenerator.generateDomains` is removed; its technical-role intent becomes contextual evidence consumed by candidate reconciliation and produces explicit disposition reason codes. The implementation must not introduce a third silent domain-filter list alongside these mechanisms.

### 3. Reconcile candidates before emission

Directory ownership, filename prefixes, graph cohesion, public entry points, routes, and schemas become signals on a common candidate model. They are not independently appended to the final list.

A nested candidate is merged into its owner when it is only a technical subdivision or its defining-file footprint is contained by the owner without an independent boundary. It remains independent when deterministic evidence demonstrates ownership, such as its own public entry point, route/schema boundary, or a structurally cohesive module that is not merely a role directory. Graph clusters may strengthen or split an ownership candidate but may not create a domain from supporting/excluded files alone.

Alternative considered: preserve all candidates and let the generation LLM choose. Rejected because it makes cost and output shape provider-dependent and violates the deterministic evidence boundary.

### 4. Persist final domains and an audit trail separately

`RepoStructure.domains` remains the compact consumer contract. The artifact will also expose a bounded candidate-decision collection containing candidate name/path, disposition (`promoted`, `merged`, `attached`, `excluded`), final owner when applicable, and stable reason codes. Summaries will report final-domain count separately from raw-candidate count.

Supporting files attached to a final domain may appear in its evidence bundle, but they do not influence whether that domain exists. Unattached analyzed source remains covered by the existing undomained disclosure, with its supporting/excluded role made explicit.

Alternative considered: emit only the smaller list. Rejected because unexplained disappearance would make regressions and user overrides difficult to diagnose.

### 5. Validate quality with invariants and representative corpora

Tests will assert behavioral invariants rather than a magic maximum domain count:

- excluded/supporting-only files never create domains;
- every final domain contains at least one defining file;
- duplicate and ancestor/descendant candidates reconcile deterministically;
- module-oriented technical children merge into their owner;
- genuinely independent nested business modules remain separate;
- input order does not affect names, memberships, or decisions;
- standalone, MCP, and Pi observe the same final domain membership.

A real OpenLore self-analysis will be recorded as a before/after acceptance fixture: the exact count may evolve, but fixture-only and technical-leaf domains must disappear without losing the major ownership areas.

## Risks / Trade-offs

- **[Risk] A heuristic merge hides a legitimate nested domain** → Require independent-boundary signals, persist the merge reason, and leave ownership overrides to a later change if real repositories demonstrate the need.
- **[Risk] Layout detection regresses Java/Kotlin behavior** → Preserve package-oriented fixtures and test layout selection per source tree.
- **[Risk] Tests lose association with the code they specify** → Keep them in the analysis corpus and attach them as supporting evidence through path/import ownership.
- **[Risk] Existing generated spec directories no longer match inferred names** → Report the delta and require explicit Generate/Repair reconciliation; never delete specs during analysis.
- **[Risk] Candidate audit data makes artifacts large** → Bound it to domain-relevant files/candidates and use stable reason codes instead of duplicating source content.
- **[Trade-off] Domain detection remains heuristic** → Prefer deterministic, inspectable imperfection over semantic guesses hidden inside an LLM call.

## Migration Plan

1. Introduce file domain roles and candidate-decision types without changing current final domains.
2. Keep tests excluded from candidate formation, then add the explicit post-reconciliation supporting-evidence attachment pass.
3. Preserve `DOMAIN_NOISE_DIRS` as path grammar, remove `ArtifactGenerator`'s local `skipDirs`, and move technical-role decisions into the explainable reconciler.
4. Add layout-aware candidate construction and reconciliation behind focused tests.
5. Switch `RepoStructure.domains` to reconciled output and add candidate-decision metadata.
6. Re-run analysis on representative TypeScript and polyglot fixtures, then on OpenLore itself.
7. Verify generation, MCP, and Pi consume the same final domains and that no analysis step deletes existing specs.

Rollback consists of restoring the prior candidate projection; no persisted source or specification data migration is destructive.

## Open Questions

None. Explicit domain-ownership configuration is deferred; this change preserves current corpus configuration and downstream domain selection only.
