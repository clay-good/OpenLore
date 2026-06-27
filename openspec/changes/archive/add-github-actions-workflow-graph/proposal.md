# GitHub Actions workflow graph: jobs, `needs`, `uses`, and composite/reusable edges on the existing IaC projector

> Status: IMPLEMENTED (2026-06-24) — branch `feat/github-actions-workflow-graph`. The CI/CD layer
> deferred from spec-07 (`classifyYaml` explicitly leaves "CI configs" as generic YAML). Builds
> directly on the spec-07 IaC subsystem (`src/core/analyzer/iac/`): the normalized
> `IacResource`/`IacReference`/`IacGraph` intermediate and the single `project.ts` projector onto
> `FunctionNode`/`CallEdge`. No graph-schema, MCP-tool, or `orient` changes.
> See "Implementation status" at the foot of this file.

## Why

OpenLore already ingests ten IaC ecosystems (Terraform, Kubernetes, Helm, CloudFormation, Ansible,
Pulumi, CDK, CDKTF, and — pending PR #193 — Dockerfile + docker-compose) by projecting a normalized
resource graph onto the existing call-graph primitives, so `orient`, `search_code`, `get_subgraph`,
`analyze_impact`, and `blast_radius` answer "who depends on this?" over infrastructure with zero tool
changes.

The one layer **nearly every repository on GitHub actually has** — `.github/workflows/` — is still
invisible. `classifyYaml` deliberately returns `null` for CI configs, so a workflow is generic YAML
to the graph. Yet "if I change this composite action / this reusable workflow, which jobs break?",
"what does this job depend on?", and "every job pinned to `actions/checkout@v3` so I can bump it at
once" are exactly graph-reachability questions. CI is also the surface a coding agent collides with
most often — a red check is the single most common thing an agent is asked to fix — and today it has
no structural model of the CI DAG. Closing it is the highest-prevalence, lowest-risk increment left in
the IaC arc.

The CI world maps cleanly onto the existing primitives — it is dependency-graph-shaped, dependent →
dependency, just like the rest of IaC:

| GitHub Actions concept | OpenLore graph primitive |
|---|---|
| A workflow file (`.github/workflows/ci.yml`) | a node (`FunctionNode`, the workflow handle) |
| A job (`jobs.<id>`) | a node |
| A composite/Docker/JS action (`action.yml`) | a node |
| A marketplace/remote action (`actions/checkout@v4`) | an external node (`isExternal`) |
| `needs: [build]` | an edge, dependent job → dependency job (`depends_on`) |
| step `uses: actions/checkout@v4` | an edge, **job → external action** (`references`) |
| step `uses: ./.github/actions/x` | an edge, **job → local composite action** (cross-file, `references`) |
| job-level `uses: ./.github/workflows/r.yml` | an edge, **job → local reusable workflow** (cross-file, `references`) |
| composite action step `uses: …` | an edge, **action → the action it nests** (`references`) |

The high-value edges are the **cross-file** ones: a job's `uses: ./.github/actions/setup` resolves to
that action's `action.yml` node, and a job-level `uses: ./.github/workflows/release.yml` resolves to
that workflow's handle node. So a single `analyze_impact` on a local composite action answers "every
job in every workflow that would break if I change this action" — end to end, deterministically, no
LLM.

## What changes

1. **One new IaC language tag** — `GitHub Actions` — added to the `IacLanguage` union and
   `IAC_LANGUAGES` (the single source of truth for IaC dispatch and gating). Workflows, jobs, and
   actions all carry it; `className` carries the resource type (`workflow` / `workflow-job` /
   `composite-action` / `action`), exactly as Terraform/K8s use `className` for the resource type. It
   rides the existing projector, so `isIacLanguage` already treats it as infra everywhere (dead-code
   roots, cross-domain linking, graph handlers).

2. **A `github-actions.ts` extractor.** A single `extractGitHubActions(files)` parses **both**
   workflow files and action metadata files together (it needs both for cross-file `uses:`
   resolution) and returns a normalized `IacGraph`:
   - **Workflow** (`.github/workflows/*.yml`): one **workflow** node (named from `name:` or the
     filename, signature carries the `on:` triggers) plus one **job** node per `jobs.<id>`.
     `needs:` → job→job `depends_on` edges. A step's `uses:` → job→action `references` edge. A
     job-level `uses:` (reusable-workflow call) → job→target `references` edge.
   - **Action metadata** (`action.yml`/`action.yaml`): one **action** node (`runs.using` distinguishes
     `composite` / `docker` / `node*`). A composite action's `runs.steps[].uses:` → action→action
     `references` edges.
   - **`uses:` resolution.** A `./`-prefixed ref is **local** (GitHub resolves it relative to the repo
     root): one ending in `.yml`/`.yaml` resolves to that workflow's handle node; otherwise it points
     at a directory whose `action.yml`/`action.yaml` is the target action node. Any other ref is
     **external** (`owner/repo@ref`, `owner/repo/path@ref`, `docker://image`) — an external node,
     deduped by reference string under the one canonical `GitHub Actions` tag, so the same action used
     by ten jobs is one node with fan-in 10.
   - **Determinism & honesty**: output is sorted (the projector already sorts), so rebuilds are
     byte-identical. A dynamic ref (`uses: ${{ matrix.action }}`, a templated reusable path) and a
     `./` local ref whose target file is not in the indexed set emit **no edge** —
     `TODO(spec-07-followup): dynamic …` — never a wrong one. Malformed-but-recoverable YAML is ignored
     rather than minting a garbage node (same posture as the compose parser).
   - **Real-world syntax robustness** (hardened by adversarial e2e review — see DOGFOOD notes): a
     `${{ … }}` expression-**masking** pre-pass (mirrors Helm's `{{ }}` masking) runs before YAML
     parse — GitHub tolerates `${{ … }}` anywhere, but strict YAML 1.2 chokes on it inside a flow
     mapping (`with: { x: ${{ y }} }`), and the parse error would otherwise desync and silently drop
     every job after it. The mask preserves newline count (line numbers stay stable) and keeps the
     value detectable as dynamic, so a partially-templated `org/action@${{ ver }}` still emits no edge.
     YAML **merge keys** (`<<: *anchor`, the shared-job-config pattern) are expanded at parse time
     (`merge: true`), so an anchored job inherits its `steps`/`needs` edges. Handles `.yml`/`.yaml`,
     CRLF/`\` paths, SHA pins with trailing comments (`@<sha> # v4`), `docker://` actions, and
     `needs:` in string or list form.

3. **Detection in `classifyYaml` + the analyze-time `resolveLang` layer, not `detectLanguage`.**
   Consistent with every other IaC ecosystem: `detectLanguage` (which the incremental watcher consults)
   stays unchanged, so a workflow edit never reaches the watcher's empty-result node-deletion path.
   Workflows are recognized by path (`.github/workflows/*.y?ml`) corroborated by top-level `on:` + `jobs:`;
   action metadata by filename (`action.y?ml`) corroborated by a top-level `runs:` key.
   `CALL_GRAPH_LANGS` gains the tag so the files reach the IaC projection pass.

## Scope contract — do not break these things

This change must NOT:
- Change the `FunctionNode` / `CallEdge` / `ClassNode` schema, the MCP tools, or `orient`. GitHub
  Actions rides the existing primitives, exactly like spec-07.
- Regress any existing language or IaC ecosystem. All current extractors and tests stay green.
- Touch `detectLanguage` (and therefore the incremental watcher's deletion-sensitive path) — GitHub
  Actions matches the established analyze-time IaC limitation (full re-analyze picks up changes; same
  as Terraform/K8s YAML today).
- Evaluate anything: no `${{ }}` expression evaluation, no `act`, no matrix expansion, no API calls.
  Static parse only.
- Over-promise precision. Emit only statically-resolvable edges; for the rest emit nothing and leave a
  `TODO(spec-07-followup): …`.

## Out of scope (deferred, as spec-07 deferred adjacent surfaces)

GitLab CI / CircleCI / Azure Pipelines / other CI ecosystems, `${{ matrix }}` fan-out as distinct
nodes, step-level granularity (steps are not nodes; the job is the unit, like a Dockerfile stage is the
unit not each `RUN`), `outputs`/`env`/`secrets` dataflow as first-class edges (low signal, high noise),
remote reusable-workflow *contents* (an `owner/repo/.github/workflows/x.yml@ref` is an external node,
not fetched), and incremental-watch support for workflow files (matches all IaC YAML today).

## Architectural decision (recorded here; `record_decision` not in the lean tool surface)

**Project GitHub Actions onto the existing IaC primitives via one new language tag and one extractor —
do not add a graph schema, MCP tool, or watcher path.** Rationale: the CI DAG is dependent→dependency
shaped and already served by `analyze_impact`/`get_subgraph`/`blast_radius`; the spec-07 projector is
the proven, zero-tool-change seam (Terraform → … → Docker all rode it). Consequence: CI topology is
analyze-time only (no live watch), and only statically-resolvable `uses:`/`needs:` edges are emitted —
dynamic refs are dropped, never guessed. This mirrors decision "IaC projects onto existing graph" and
the Docker container-graph follow-up.

## Implementation status

Tracked in `tasks.md`. Verified by `src/core/analyzer/iac/github-actions.test.ts` (unit) and the IaC
`integration.test.ts` (end-to-end through `CallGraphBuilder`), plus a dogfood run on OpenLore's own
`.github/` (workflows `ci.yml`/`release.yml` + the `openlore-review` composite action), recorded in
`DOGFOOD-github-actions-workflow-graph.md`.
