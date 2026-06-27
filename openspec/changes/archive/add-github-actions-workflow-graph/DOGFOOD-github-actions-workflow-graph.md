# Dogfood — GitHub Actions workflow graph (on OpenLore's own `.github/`)

Date: 2026-06-24. Branch `feat/github-actions-workflow-graph`. Method: ran the real
`openlore analyze` pipeline over OpenLore's own CI files, then queried the persisted edge
store (`call-graph.db`) the same way `analyze_impact` does — no test fixtures.

## Corpus (real, on this repo)
- `.github/workflows/ci.yml` — jobs `lint`, `test`, `build`, `ci-success` (`needs: [lint, test, build]`).
- `.github/workflows/release.yml` — jobs `validate`, `create-release`, `publish` (a `needs` chain).
- `.github/actions/openlore-review/action.yml` — a **composite** action nesting `actions/setup-node@v4`
  and `actions/github-script@v7`.
- `.github/workflows/openlore-review.yml.example` — correctly **ignored** (`.example`, not `*.yml`).

## What the extractor produced (direct `buildProjectedIac`)
- **15 nodes**: 2 workflow handles (`CI on [push, pull_request]`, `Release on [push, release,
  workflow_dispatch]`), 7 jobs, 1 composite action, 5 deduped external actions
  (`actions/checkout@v6`, `actions/setup-node@v6`, `actions/setup-node@v4`,
  `actions/upload-artifact@v7`, `actions/github-script@v7`).
- **20 edges**: the CI `needs` DAG (`ci-success → lint/test/build`), the release chain
  (`validate → create-release → publish`), each job's step `uses:` → external action, and the
  composite action's nested `uses:` (`openlore-review action → setup-node@v4`, `→ github-script@v7`).

## End-to-end through the real CLI pipeline
`openlore init && openlore analyze --no-embed --force` on an isolated copy of `.github`:
- `✓ Built keyword (BM25) search index (15 functions)` — the 15 GitHub Actions nodes flow through
  `classifyYaml` → `resolveLang` → `CALL_GRAPH_LANGS` → the projector → the edge store.
- `call-graph.db`: `nodes WHERE language='GitHub Actions'` = **15**; `edges` = **6 depends_on +
  14 references = 20** — identical to the direct run (deterministic).

### `analyze_impact`-style reachability queries on the persisted graph
- **"Who breaks if `actions/setup-node@v6` moves?"** (callers of the external node) →
  `ci.yml::job.build`, `ci.yml::job.lint`, `ci.yml::job.test`, `release.yml::job.publish`,
  `release.yml::job.validate` — all 5 jobs across **both** workflows. ✅
- **"Who needs `ci.yml::job.build`?"** → `ci.yml::job.ci-success` (`depends_on`). ✅

## Honesty checks (unit-verified, see `github-actions.test.ts`)
- `uses: ${{ matrix.action }}` → no edge, and no garbage external node minted.
- `uses: ./.github/actions/missing` (target not indexed) → no edge.
- Recoverable-but-malformed workflow YAML → no node, no throw.

## Adversarial e2e round (real-world workflow shapes)
A second pass ran an adversarial harness of realistic workflows (matrix + container + services,
remote reusable workflows, SHA pins with trailing comments, `docker://` actions, monorepo nested
composite-action chains, `needs` diamonds, YAML anchors) and two independent review agents. It
surfaced two genuine defects, both fixed here with regression tests:

1. **Flow-mapping `${{ }}` dropped downstream jobs.** `with: { node-version: ${{ matrix.node }} }`
   is valid GitHub syntax but breaks strict YAML 1.2 flow parsing; the parse error desynced and
   silently dropped every job declared *after* it (the matrix CI fixture fell from the expected 9
   nodes / 6 edges to 4 / 1). Fixed with a `${{ … }}` masking pre-pass (offset-preserving, keeps
   dynamic-ref detection). The matrix fixture now recovers fully.
2. **YAML merge keys lost inherited edges.** A job using `<<: *anchor` to inherit `steps`/`needs`
   carried none of the anchored edges, because `parseDocument` ran without `{ merge: true }` (the
   compose parser sets it). Fixed; an anchored job now inherits its edges.

Verified-not-bugs in the same pass: `on:`→boolean coercion does not occur (yaml v2 is YAML 1.2),
`needs` forward-references, SHA-pin comments, `docker://`/remote-reusable externals, and determinism
across input file order (the projector sorts). Two edge cases left acceptable-as-documented: a
duplicate-job-key file is dropped whole (GitHub rejects it too), and a repo-root action referenced as
`uses: ./` is unresolved.

## Second adversarial round (new angles + claim-vs-reality audit)
A follow-up pass probed angles the first did not, and an independent claim-vs-reality audit checked
every doc claim against code + tests. No new bugs; it closed real test-coverage gaps (all now green):

- **SCIP export of GitHub Actions nodes — VERIFIED.** Ran the real `exportScip` over a GHA graph: the
  3 local nodes (workflow handle + job + composite action) export as 3 SCIP symbols under
  `unspecifiedLanguageFiles` (language `''`, exactly like every other IaC tag); the external
  `actions/checkout@v4` is correctly skipped (no file). This backs the docs' "SCIP export works on IaC
  unchanged" claim, which had **no** test before — added `export.test.ts` coverage (and extended the
  stale spec-07 IaC→UnspecifiedLanguage tag list to include `GitHub Actions`).
- **Masking-regex perf / ReDoS — safe.** 5,000 unclosed `${{` tokens parse in ~106 ms; 5,000 closed
  `${{ }}` in ~43 ms. The non-greedy `${{ … }}` mask does not backtrack pathologically.
- **`with:` input literally named `uses` → no false edge** (only a step's top-level `uses:` is read).
  Added a regression test.
- **Remote reusable workflow** (`owner/repo/.github/workflows/x.yml@ref`) → external node. Added a test.
- **`services:`/`container:` images are not nodes** (out of scope). Added a guard test.
- **Leading `---` document start marker** (common YAML) parses fine; only a genuine *trailing*
  multi-document workflow (invalid GitHub syntax → `MULTIPLE_DOCS`) is dropped, same acceptable class as
  duplicate keys. Added a leading-`---` test.
- **Audit note (pre-existing doc fix, folded in on request):** `docs/cross-domain-impact.md:5` said
  "seven" while listing eight embedded-IaC ecosystems — a CDK/CDKTF-era miscount. Corrected to "eight".
  GitHub Actions is config, not embedded-in-code IaC, so it is correctly **excluded** from this
  cross-domain list (cross-domain edges link a code function to the resource it provisions; workflows
  have no co-located provisioning code). The spec-17 line (`openlore-spec-17-cross-domain-impact.md:43`)
  lists seven items and says "seven" — internally consistent — so it was left as-is.

## Third round — downstream-consumer integration audit (`isIacLanguage`)
A third pass verified every consumer of `isIacLanguage` / the IaC node set handles GitHub Actions
identically to the 8 pre-existing ecosystems (an independent audit agent + code reading confirmed no
per-ecosystem branching anywhere). **No bugs.** Two consumers back claims this PR makes, so each got a
GHA-specific regression test (both now green; full suite 4700 passed):

- **Incremental watcher — workflow files are skipped (the proposal's safety claim).** `detectLanguage`
  returns `'unknown'` for `.github/workflows/*.yml` (`.yml`/`.yaml` are not in `EXT_TO_LANGUAGE`), so
  the watcher's gate (`mcp-watcher.ts:433`) skips them — a workflow edit never reaches the call-graph /
  node-deletion path, exactly like all IaC YAML. Added `mcp-watcher.test.ts`: editing a real
  `.github/workflows/ci.yml` leaves the context artifact byte-identical (no-op). Previously the only
  watcher skip test used a `.txt` file.
- **find_dead_code — a CI workflow is never flagged dead.** `isCodeNode` (`reachability.ts:79`) excludes
  `isIacLanguage` nodes from the dead-code universe, so a callerless workflow handle/job is never a
  candidate (an agent must not be told "your CI workflow is dead code"). Added `reachability.test.ts`: a
  GHA workflow + job are absent from `candidateDead` while a genuinely-dead TS function is present.
- **Verified safe-by-precedent, no change needed:** cross-domain `linkCodeToInfra` mints no GHA edges (a
  `.yml`/action file has no co-located code nodes, so `codeByFile.get(...)` is always undefined — same as
  standalone Terraform); `get_map`/clustering label GHA by `className` like every IaC type;
  `orient`/`search_code` index GHA nodes as ordinary `FunctionNode`s (no exclusion path); the federation
  manifest is a repo index-of-indexes (no per-symbol data), and cross-repo symbol resolution passes IaC
  nodes through unfiltered.

## Verdict
The CI DAG is now a first-class part of the same graph as application code and the other ten IaC
ecosystems, with zero MCP-tool or schema changes — the spec-07 projector carried it unchanged.
"Which CI jobs break if I bump this shared action?" is one `analyze_impact`.
