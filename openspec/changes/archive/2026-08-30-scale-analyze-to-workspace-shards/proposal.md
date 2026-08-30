# Scale analyze to workspace shards

> Status: IMPLEMENTED (2026-08-30, known-limitations closure #5 of 6).

## What Changes

After one complete analysis, a monorepo can recompute one package with
`openlore analyze --shard <name>` without replacing the whole-repository graph with a narrowed
subdirectory graph. OpenLore detects package boundaries from repository manifests, retains every
unselected package, and re-resolves the cross-package call sites whose answer may have changed.

The run is honest about partiality. Its receipt names selected and retained shards, each retained
shard's last-recomputed state, the resolution frontier, and any files that exceeded the bounded
work budget and were marked stale. It never writes the repository-wide freshness fingerprint or
rebuilds repository-wide JSON/search artifacts from shard-only input.

## Why

The analyzer previously treated a repository as one flat corpus. Include patterns could reduce
the files passed to analysis, but that silently amputated cross-package edges and produced a
different graph. Large monorepos therefore had to choose between repeated whole-repo work and a
faster graph that was quietly incomplete.

Workspace shards change the unit of recomputation, not the graph's scope. Detection uses npm/yarn
workspaces, `pnpm-workspace.yaml`, Cargo workspace members, Go modules, nested Python projects,
Gradle settings, and Maven modules. `workspace.shards` can replace detection. Membership is
assigned after the existing include/exclude rules, the most-specific root wins, and unmatched
files belong to an implicit `root` shard.

## Soundness contract

A scoped run recomputes the selected files and three frontier classes:

1. stored edges touching a selected shard;
2. outside files with unresolved external calls that a newly added name can bind; and
3. outside files whose name-only resolution changes because a definition name becomes unique or
   ambiguous.

The implementation reuses the incremental watcher's resolver seed, closure budget, and stale
region vocabulary. Rows for selected/frontier files are swapped under the analysis lock. The
remaining SQLite rows are retained, and the resulting whole graph receives a fresh whole-graph
attestation. If a frontier file cannot be read or fit within budget, it is explicitly stale.

## Compatibility and boundaries

- No detectable workspace means one `root` shard and the legacy full-analysis path. No extra
  shard artifact is written, preserving the single-package artifact set.
- `--shard` without an existing index performs and discloses a full analysis.
- `--shard` with `--force` performs and discloses a full rebuild.
- Unknown names fail with available and nearest candidates.
- Automatic shard selection from a git diff is not part of this change; callers pass one or more
  repeatable `--shard` options.
- Portable Pass-1 cache export/import is intentionally deferred to a separate change. It has a
  distinct trust boundary and depends on authenticated bundle import; combining it here would
  violate the one-problem-per-PR scope.

## Impact

- New detector and scoped graph-update modules under `src/core/analyzer/`.
- Optional `workspace.shards` configuration.
- Repeatable `openlore analyze --shard <name>`.
- `.openlore/analysis/workspace-shards.json` for multi-shard full/scoped receipts.
- Documentation in the CLI, configuration, CI, and README references.
