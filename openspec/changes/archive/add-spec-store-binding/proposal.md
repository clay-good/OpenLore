# Spec-store binding: let OpenLore stand on an external plan that points at many repos

> Status: IMPLEMENTED (2026-06-21) — shipped on branch `feat/spec-store-binding`. Decision
> `c6e36101`. First of three changes in `SPEC-STORE-INTEGRATION.md`. Builds on
> `add-multi-repo-federation` (index-of-indexes, stable cross-repo IDs). Foundation for
> `add-working-set-context-briefing` and `add-change-impact-certificate`.
> See "Implementation status" at the foot of this file.

## Why

OpenLore indexes one repository at a time. But the unit of work for a team is increasingly a **plan
that lives in its own repository, separate from code**, and that plan is *about* one or more target
code repositories. A developer (or their agent) registers the plan repository by name and checks out
the code repositories locally; the plan declares which repositories it targets and which it merely
references for context.

OpenLore cannot currently see any of this. It has no way to learn that an external plan repository
exists, which local code checkouts its declared targets resolve to, or whether that binding is even
healthy (every target resolvable, every reference present, indexes built and fresh). Without the
binding, the two capabilities that follow — assembling working-set context and certifying a change's
impact across targets — have no footing.

The hard part is already built. `add-multi-repo-federation` gives OpenLore an index-of-indexes across
repositories and stable cross-repo symbol IDs. A spec-store binding is the thin, declarative layer that
maps an external plan's declared target/reference names onto that federation set, plus a health check
that tells the developer (and an orchestrator) whether the picture is sound.

## What changes

1. **A registerable spec-store binding.** OpenLore can be pointed at an external spec repository and
   record a binding: the store's name, its local path, and the **target** and **reference** code
   repositories it declares. The binding is configuration only — OpenLore reads the store's declared
   relationships; it never clones, syncs, writes to, or fences the store or its targets.

2. **Name resolution onto the federation set.** Declared target/reference names are resolved to local
   repository indexes via `add-multi-repo-federation`. A resolved target becomes a member of the
   binding's federation set, so cross-repo structural facts (reachability, published-interface
   consumers) are computable across the plan's targets.

3. **A deterministic binding health check.** A `conclusion`-shaped report answers "is this binding
   sound?": every declared target resolves to a local checkout, every reference is present, each
   target's index exists and is fresh relative to its working tree, and no declared name is dangling.
   Each finding carries a stable code and a pasteable remediation. The check is read-only and never
   blocks.

4. **A stable machine contract.** The binding and its health check are exposed over an MCP tool and a
   CLI command, both emitting documented `--json` with stable finding codes, so an external orchestrator
   can register, resolve, and verify a binding without parsing prose.

## What does NOT change

- **No LLM.** Resolution and health are deterministic configuration and filesystem/index checks. The
  north star (`c6d1ad07`) holds.
- **No new structural computation.** This change wires the external plan's declarations onto the
  existing federation index; it adds no new graph analysis.
- **No mutation of the store or targets.** OpenLore reads declared relationships and reports. It does
  not clone, write, sync, or fence anything. Declarations are inputs, not authority.
- **No default-surface growth.** The binding tool stays out of the `minimal` / first-run default
  preset; it is opt-in for repositories participating in an external spec-store workflow.

## Research basis

Federated code intelligence over an index-of-indexes (already shipped here), combined with a
declarative project-binding model in which an out-of-tree plan names the in-tree repositories it
concerns. The health-check posture mirrors a read-only readiness probe: every finding is actionable and
nothing is mutated.

## Application to OpenLore

- **Federation set** reuses `add-multi-repo-federation`'s index-of-indexes and stable-ID resolution.
- **Index freshness** reuses the existing staleness signals used by `preflight` / the watcher
  (`add-watch-incremental-dependency-graph`).
- **Config** extends `OpenLoreConfig` with an optional, additive `specStore` binding block; absent
  binding means current single-repo behavior is unchanged.
- **Contract** reuses the `conclusion` classification in `tool-contract.ts` and the `--json` emission
  pattern already used by `blast-radius` and `federation_status`.

## Out of scope

- **Assembling context** for a change across the targets — that is `add-working-set-context-briefing`.
- **Certifying impact** of a change — that is `add-change-impact-certificate`.
- **Cloning, syncing, or writing** to the external store or its targets. The binding is read-only.
- **Discovering** the store automatically. The binding is registered explicitly; auto-discovery is a
  later convenience, not a prerequisite.

## Implementation status (2026-06-21)

**Shipped end-to-end.** Read-only, deterministic, no LLM. Spec deltas merged into
`openspec/specs/mcp-handlers/spec.md` (SpecStoreBinding, SpecStoreNameResolution, SpecStoreHealthCheck)
and `openspec/specs/cli/spec.md` (SpecStoreStatusCommand).

- **Config**: `OpenLoreConfig.specStore?: { name, path, targets[], references? }` — optional, additive
  (`src/types/index.ts`). Absent binding ⇒ unchanged single-repo behavior; `readOpenLoreConfig` is
  untouched (no new throw on the 33-caller hub).
- **Core**: `src/core/services/mcp-handlers/spec-store.ts` — `handleSpecStoreStatus()` composes the
  federation registry only (`loadRegistry`/`listRepos`/`evaluateRepoState`); `validateSpecStoreConfig()`
  returns findings, never throws. Targets/references resolve **by name** against
  `.openlore/federation.json`. The report is conclusion-shaped (counts + named findings), never a graph.
- **Stable finding codes** (the `--json` contract): `no-binding` (info), `binding-invalid` (error —
  empty name/path, self-referential store path, duplicate names, **a name listed as both a target and a
  reference**), `registry-unreadable` (error — corrupt `.openlore/federation.json`),
  `store-path-missing` (error), `target-unresolved` (error), `target-missing` (error), `index-missing`
  (warn), `index-stale` (warn), `reference-missing` (warn). `sound` is true when there are no
  error-severity findings. References are checked for presence only (they are context, not impact
  targets); targets carry index freshness.
- **Adversarial hardening (post-review, same PR).** A corrupt federation registry made
  `handleSpecStoreStatus` throw on the MCP dispatch path (the CLI caught it, the tool did not) — fixed
  by catching `loadRegistry` and degrading to `registry-unreadable` with no per-target cascade. A
  relative store path was resolved against `process.cwd()` in the self-reference check but against the
  bound repo in the presence check — unified to the bound repo. The report now echoes the trimmed store
  name/path it actually validated. Regression tests cover all of these, including a `dispatchTool`
  route test (the surface the throw escaped through).
- **Second adversarial pass (same PR).** A wrong-typed config field (`"name": 123`, `"path": 456`, or a
  non-string entry in `targets`/`references`) made `.trim()` throw — the same no-throw contract
  violation via a different door, since config arrives as unvalidated `JSON.parse`. Fixed with
  type-safe coercion: a non-string `name`/`path` degrades to `binding-invalid` ("not a string"), and
  non-string array entries are flagged and dropped from resolution (no numeric cascade). Also cleaned a
  spec-categorization defect: the decision sync had appended this binding's requirement to the
  unrelated `analyzer` and `drift` specs (over-inferred `affectedDomains`); removed from both, retained
  in `config`/`mcp-handlers`/`cli` where it belongs.
- **MCP tool**: `spec_store_status` — classified `conclusion` in `tool-contract.ts`; registered in
  `tool-dispatch.ts`, `TOOL_DEFINITIONS` (`mcp.ts`), and the live `tool-driver.ts` registry. Added to
  the opt-in `federation` preset (it resolves against the same registry, like `federation_status`);
  kept OUT of `minimal`/`navigation`/`memory`. Full surface 60 → 61; the `tools/list` payload ceiling
  was bumped 61_000 → 62_000 as a conscious budget decision; count-guarded docs updated.
- **CLI**: `openlore spec-store status [--json]` (`src/cli/commands/spec-store.ts`, registered in
  `src/cli/index.ts`). Read-only, always exits 0 (reports health, never blocks). `runSpecStoreStatusCli`
  is factored out for testing.
- **Tests**: `spec-store.test.ts` (handler: validation, resolution, every finding state, conclusion
  shape — 13) and `spec-store.test.ts` (CLI: `--json` findings + no-binding — 2). Full suite green
  (4298 pass, 2 skip); the registration guards (`tool-contract`, `tool-driver`, `mcp-presets`,
  `mcp-tool-count-doc`) all pass with the new tool.
- **Dogfood**: see `DOGFOOD-spec-store-binding.md` — registered this repo as an indexed target and
  observed `indexed` / `target-unresolved` / `reference-missing` end-to-end through the built binary.

### Scoped deviation from the draft

- **Resolution is by federation-registered name.** A declared target/reference name must match an entry
  in `.openlore/federation.json`; an unregistered name surfaces as `target-unresolved` /
  `reference-missing` with a `openlore federation add …` remediation rather than an error. This is the
  documented contract (decision `c6e36101`), keeping the binding a thin declarative layer with no index
  machinery of its own.
