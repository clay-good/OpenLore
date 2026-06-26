# Shareable graph artifact (`export bundle` / `import`)

The OpenLore graph index is a deterministic function of the committed source: for a given commit, every
machine computes the **same** index. So re-indexing it on every teammate's laptop and on every CI run is
redundant work that scales with team size. A shareable bundle lets a team **index once and bootstrap
everywhere** — verified, in seconds, or transparently rebuild if the bundle can't be trusted.

> Sharing is **opt-in**. Default single-machine operation is unchanged. No network service, no registry,
> no LLM — `export`/`import` are local, offline, and deterministic.

## TL;DR

```bash
# Producer: analyze once, export a portable artifact (commit it, or attach it to CI cache)
openlore analyze
openlore export bundle                       # → .openlore/index-bundle.olbundle

# Consumer: a teammate or CI bootstraps a verified index without re-analyzing
openlore import .openlore/index-bundle.olbundle
```

## The artifact

`openlore export bundle [--out <path>]` serializes the persisted index under `.openlore/analysis/` into a
single, compact, self-describing file (default `.openlore/index-bundle.olbundle`). It is a gzipped JSON
envelope of:

- a **manifest** — the bundle format version, the OpenLore version, the index **schema version**, the
  **source commit** the index was built from, the bundled **integrity attestation** (committed
  file/function/edge/class counts + a content digest), and a **payload digest** over the bundled bytes;
- a **payload** — the graph files (`call-graph.db`, `llm-context.json`, the JSON inventories, …),
  base64-encoded.

The LanceDB **search index** (`vector-index/`, `text-line-index/`, and `vector-index-meta.json`) is **not**
bundled — it is large and a deterministic function of the graph. Instead, **import rebuilds the keyword
(BM25) search index from the materialized graph** (offline, no API, well under a second): the code index
over every symbol — functions *and* the non-callable ones (constants, types, interfaces, enums), drawn from
the per-file signatures the bundle carries in `llm-context.json` and the checked-out source for body text —
and the spec index. So `orient`, `search_code`, and `search_specs` work immediately on an imported index,
returning the same results a fresh `openlore analyze` would. Semantic (embedding) search stays an explicit
opt-in: run `openlore embed --local` (on-device, no API key) after import. The one search feature not
restored on import is the literal-text line index (`text-line-index/`, used by some `find_dead_code` /
literal-string lookups); it is rebuilt by the next `openlore analyze`. Transient SQLite WAL sidecars are
excluded; the store is checkpointed before export so the bundled `call-graph.db` is self-contained.

**Deterministic.** Exporting the same index twice produces a byte-identical artifact (sorted file order, no
wall-clock field, fixed compression level). The bundled attestation is **re-computed from the live store at
export time** so it describes exactly the bytes being exported — this is what makes the import-time digest
check a true tamper detector rather than a false positive on an index the incremental watcher has touched.

## Import is validate-or-rebuild (safe by construction)

`openlore import <artifact>` never serves a stale, schema-mismatched, or tampered bundle as current. It runs
this ladder and, on **any** validation failure, degrades transparently to a full local rebuild — so import
never leaves you worse off than having no artifact:

| # | Check | Failure → |
|---|-------|-----------|
| 1 | Bundle format version compatible | rebuild |
| 2 | Index schema version matches this OpenLore | rebuild (`mismatched`) |
| 3 | Payload byte-integrity (corrupt / hand-edited / line-merged) | rebuild |
| 4 | Graph-content digest == bundled attestation, store reconciles healthy | rebuild (tampered) |
| 5 | **Currency** vs. the working tree (below) | see below |

Currency outcomes once the artifact has validated:

- **commit == HEAD** → imported as-is, **verified current** (the fast, no-analyze path).
- **no git repo / no recorded build commit** → imported as-is, but currency is **disclosed as
  UNVERIFIED** (run `openlore analyze` if the source has changed).
- **stale (built at an ancestor commit)** or **diverged/unknown** → **full local rebuild**, so the index is
  current. (Incremental-delta update of only the changed files is a deferred optimization; the rebuild
  result is identical to a fresh analyze at the working-tree commit.)

Any *unexpected* failure during materialization or validation (e.g. a structurally-valid bundle whose
`call-graph.db` turns out to be corrupt) also degrades to a rebuild rather than crashing the command.

On a successful as-is import, any **stale search index** from a prior index in the target directory
(`vector-index/`, `text-line-index/`) is cleared first — its embeddings would otherwise describe a graph
that no longer matches — and the keyword (BM25) index is rebuilt for the imported graph.

**What works immediately after import.** Everything that reads the call graph — `orient`, `search_code`,
`search_specs`, `analyze_impact`, `find_path`, `blast_radius`, `select_tests`, `report_coverage_gaps`, and
the rest — works right away on a verified import, no re-analyze: the keyword (BM25) code and spec search
indexes are rebuilt on import over the full symbol set. Two things are *not* restored on import and wait for
the next `openlore analyze`: *semantic* (embedding) search (opt in any time with `openlore embed --local`),
and the literal-text line index (`text-line-index/`). Everything else matches a fresh analyze.

**Exit codes.** `export` and `import` exit `0` on success — and import exits `0` on the rebuild path too,
since a rebuild is a successful outcome, not an error. A genuine *user* error exits `2`: an artifact path
that doesn't exist, a file that isn't an OpenLore bundle at all (wrong path / not a `.olbundle`), or `export`
run before `openlore analyze` (no index to bundle). These are clean errors, never a silent rebuild.

**Untrusted-input safety.** A `.olbundle` is treated as untrusted on-disk input. Import bounds the
decompressed artifact (2 GiB cap) and fails closed on anything larger — a crafted bundle cannot exhaust
memory (zip-bomb guard). Every bundled file name must be a plain basename: a payload entry containing a path
separator, `..`, or an absolute path is **rejected before anything is written to disk** (no path-traversal
arbitrary write), and the manifest's file list must exactly match the payload it describes. The graph itself
(`call-graph.db`) is validated against the attestation's content digest; the remaining bundled artifacts
(JSON inventories, summaries) are trusted to the same degree as the bundle's source — treat an
externally-supplied bundle like externally-supplied code.

## Conflict-free git discipline: regenerate, don't merge

If you commit the artifact to share it, treat it as a **generated, regenerate-on-divergence** file. A graph
artifact is not hand-mergeable — a line-merged graph is a corrupt graph, and the import-time integrity check
rejects it regardless.

Add to `.gitattributes` (the `export bundle` command prints this hint):

```gitattributes
.openlore/index-bundle.olbundle -diff -merge
```

When two branches each re-exported the artifact and git reports a divergence, the canonical resolution is to
**re-export at the merge commit** — never resolve it by hand:

```bash
git checkout --theirs .openlore/index-bundle.olbundle   # or --ours; the bytes don't matter
openlore analyze && openlore export bundle              # regenerate at the merge commit
git add .openlore/index-bundle.olbundle
```

> `.openlore/` is gitignored by default. To share the artifact, force-add it:
> `git add -f .openlore/index-bundle.olbundle`.

## CI bootstrap recipe

Turn per-run cold indexing into a verified import plus (at most) a small rebuild. Because import validates
against the checked-out commit, it is safe to run unconditionally:

```yaml
# .github/workflows/ci.yml (excerpt)
- name: Bootstrap OpenLore index
  run: |
    if [ -f .openlore/index-bundle.olbundle ]; then
      npx openlore import .openlore/index-bundle.olbundle   # verified import, or transparent rebuild
    else
      npx openlore analyze
    fi
```

If the committed artifact is at the CI checkout's commit (the regenerate-don't-merge discipline keeps it
there), import is a fast, verified file-materialization. If the artifact lags the checkout, import rebuilds —
correct, just not free. Either way the job ends with a current, trustworthy index.

## What this is not

- Not a new on-disk graph schema and not a graph merge algorithm — it exports the existing index and
  regenerates on divergence.
- Not a hosted cache or registry — it is git-distributed and offline.
- Not a way to serve a stale graph — validate-or-rebuild is mandatory.

Deferred follow-ups: incremental-delta import for the stale path, artifact signing/provenance beyond the
content digest, and cross-repo/federated bundles (federation already has its own index-of-indexes).
