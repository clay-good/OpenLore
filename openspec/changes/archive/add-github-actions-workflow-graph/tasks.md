# Tasks — GitHub Actions workflow graph

## 1. Language tag
- [x] Add `'GitHub Actions'` to the `IacLanguage` union and `IAC_LANGUAGES` (`iac/types.ts`).
- [x] Add `'GitHub Actions'` to the cfg-language fail-soft contract guard (`cfg.test.ts`).

## 2. Extractor (`iac/github-actions.ts`)
- [x] `isWorkflowPath` / `isActionMetadataPath` path predicates.
- [x] Parse workflow files: workflow handle node + one job node per `jobs.<id>`.
- [x] `needs:` → job→job `depends_on` edges (same-file).
- [x] Step `uses:` → job→action `references` edges (local resolved / external deduped).
- [x] Job-level `uses:` (reusable workflow) → job→target `references` edge (local resolved / external).
- [x] Parse action metadata files: action node; composite `runs.steps[].uses:` → action→action edges.
- [x] Local `./` ref resolution relative to repo root; `.yml`→workflow handle, dir→`action.y?ml`.
- [x] Dynamic `${{ }}` refs and unresolvable local refs → no edge (honesty); external dedup by ref.

## 3. Detection wiring
- [x] `classifyYaml`: workflow by `.github/workflows/*.y?ml` + `on:`/`jobs:`; action by `action.y?ml` + `runs:`.
- [x] `iac/index.ts`: dispatch `'GitHub Actions'` files to `extractGitHubActions`; export predicates.
- [x] `artifact-generator.ts`: add tag to `CALL_GRAPH_LANGS` (detection already flows via `classifyYaml`).

## 4. Tests
- [x] `github-actions.test.ts` — unit: jobs, `needs`, step `uses` (local+external), reusable workflow,
      composite action nesting, dynamic-ref drop, determinism, malformed YAML.
- [x] `integration.test.ts` — e2e through `CallGraphBuilder`: nodes present, `analyze_impact` on a
      shared action returns its job dependents.

## 5. Verify + dogfood
- [x] `npm run typecheck`, `npm run lint`, `npm run test:run` all green.
- [x] Dogfood: `openlore analyze` on this repo, then query the graph for the CI jobs/actions.
- [x] Record findings in `DOGFOOD-github-actions-workflow-graph.md`.

## 6. Docs
- [x] `docs/iac.md` — add the GitHub Actions ecosystem section + the language-tag list.
- [x] `README` — add GitHub Actions to the IaC ecosystem list.
- [x] Flip the proposal header to IMPLEMENTED.
