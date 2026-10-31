# Build-graph ingest: declared monorepo target structure as provenance-tagged evidence

> Status: PROPOSED (2026-07-08, e2e audit fifth pass — fifth research sweep). Prior art:
> Nx project graph export (https://nx.dev/docs/features/explore-graph), Turborepo `turbo query`
> (stable GraphQL since 2.9, https://turborepo.dev/blog/2-9), `bazel query
> --output=streamed_jsonproto`, bazel-diff (https://github.com/Tinder/bazel-diff), `pants peek`.
> The `add-scip-index-interchange` pattern — ingest a foreign artifact the user already produces,
> provenance-tag what it contributes — applied to build graphs.

## The gap

Every major monorepo tool exports its project graph as machine-readable data: `nx graph
--file=graph.json`, `turbo query`, `bazel query --output=streamed_jsonproto`, `pants peek`, and
bazel-diff's per-target hash maps. That artifact is **declared dependency structure at target
granularity** — what the build says depends on what — which OpenLore's symbol-level graph can
consume but cannot derive (a `project.json` implicit dependency, a Bazel `deps` edge with no
corresponding import). The two graphs answer different questions, and their **disagreement** is
itself a conclusion: a file-level dependency the build graph doesn't declare is an undeclared
dependency waiting to break CI caching; a target-level edge with no code path behind it means the
build graph is coarser than reality and CI is re-testing more than it must. Today OpenLore cannot
read any of these artifacts (verified: no build-graph consumption in `src/`).

## What changes

**`openlore ingest --build-graph <file>` (CLI only — no MCP tool, no payload-budget impact):**

- **Format adapters** for the artifacts named above, each detected explicitly; an unparseable or
  unknown-format artifact is an **explicit unsupported error, graph unchanged** — never silently
  partial (the `openlore import` validate-or-rebuild discipline, `src/cli/commands/import.ts:1-17`).
- **Provenance-tagged, target-granular edges.** Ingested nodes are build targets, ingested edges
  carry `declared::` provenance — the `external::` precedent: a distinct evidence tier that is
  never presented as a call edge and never merged into call-graph reachability. The tree-sitter
  graph stays canonical; the overlay is droppable.
- **Staleness = the artifact's generation commit vs HEAD**, in the existing freshness-lease
  vocabulary: an artifact recording its commit is checked against HEAD (current → trusted; stale
  → disclosed staleness, not silent authority); an artifact without one is `currency UNVERIFIED`,
  disclosed — the bundle importer's currency ladder exactly (`import.ts`, step 5).
- **Three consumers:**
  1. **Declared module boundaries** become available to architecture rules — the filed
     `widen-architecture-rule-vocabulary` change's rule kinds can match on declared targets
     instead of hand-written path globs (coordination cross-ref; that change is not modified here).
  2. **The cross-check conclusion** (`openlore ingest --build-graph <file> --check`): where
     OpenLore's file-level affected set (from `getChangedFiles` + import edges) and the build
     tool's target-level affected set disagree, each direction is a registered finding —
     `build-graph-disagreement` (advisory, `FINDING_CODE_REGISTRY`,
     `src/core/services/mcp-handlers/enforcement-policy.ts:81`): code-reaches-but-undeclared
     (undeclared dependency) or declared-but-no-code-path (coarser-than-reality build graph),
     each with the witnessing files/targets as receipts.
  3. **Target scoping** for `select_tests` / `blast_radius`: where CI is target-driven, the
     reaching-test set is additionally expressed as the covering targets, so the agent can name
     the CI shards to run.

Symbol-grain cross-ref: bazel-diff's content-hash diffing has a filed symbol-level analog,
`add-symbol-content-hashes` — cited, not re-filed; ingest works at target grain by construction.
Naming: `import` bootstraps/re-binds the index (bundle, SCIP occurrences); `ingest` overlays
foreign *declared* evidence — if implementation review prefers one verb, folding this under
`openlore import --build-graph` is acceptable; the contract is unchanged either way.

## Addendum (2026-10-31): read workspace manifests natively, with no export step

Source: `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`. The ingest above needs an exported build-tool
artifact. Most monorepos also declare packages in plain manifests that OpenLore can read with no
tool installed: npm/yarn/pnpm `workspaces` / `pnpm-workspace.yaml`, Nx `project.json`, Cargo
`[workspace]`, `go.work`. A zero-config tier reuses the workspace reader the analyzer already has (`workspace-shards.ts`,
which reads these files for shard-scoped analysis) and turns its output into package nodes (name, root, declared
dependencies on sibling packages, the package's own `test` script) with the same `declared::`
provenance and droppable-overlay rule. It feeds the same consumers: package-level affected set for
`blast_radius`, per-package test commands for `select_tests`, and declared package boundaries for
architecture rules. When an exported artifact is also present, the artifact wins and disagreements
are the existing `build-graph-disagreement` finding.

## Why this is in scope

Decision `c6d1ad07`: deterministic, local, no LLM — the artifact is produced by the user's own
build tool, consumed offline. Like SCIP ingest, it imports truth OpenLore cannot compute (declared
intent) and keeps it honestly separated from what it does compute (observed structure); the
disagreement finding exists only because both graphs live in one substrate.

## Impact

- New: `src/core/analyzer/build-graph/` (format adapters + normalized target graph),
  `src/cli/commands/ingest.ts` (or an `import` flag), the cross-check join, the
  `build-graph-disagreement` finding code, target-scoping joins in `test-impact.ts` /
  `blast-radius.ts`.
- Tool surface: unchanged (no new MCP tool; description edits to `select_tests`/`blast_radius`,
  if any, re-assert the `mcp-presets.test.ts` budgets).
- Specs: `analyzer` — 1 ADDED (BuildGraphIngestCarriesDeclaredProvenance); `architecture` —
  1 ADDED (DeclaredTargetCrossCheckIsARegisteredFinding).
- Risk: format churn across five tools (mitigated: adapters are versioned per format; an
  unrecognized version is explicit unsupported); target↔file mapping precision (mitigated: the
  artifact's own source-root/file lists are used; a target whose files cannot be resolved is
  counted and disclosed, never guessed).
