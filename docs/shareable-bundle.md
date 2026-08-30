# Shareable graph artifact (`export bundle` / `import`)

The OpenLore graph index is a deterministic function of the committed source: for a given commit, every
machine computes the **same** index. So re-indexing it on every teammate's laptop and on every CI run is
redundant work that scales with team size. A shareable bundle lets a team **index once and bootstrap
everywhere** — integrity-checked in seconds, or transparently rebuilt if it cannot be used.

> Sharing is **opt-in**. Default single-machine operation is unchanged. No network service, no registry,
> no LLM — `export`/`import` are local, offline, and deterministic.

## TL;DR

```bash
# Producer: analyze once, export a portable artifact (commit it, or attach it to CI cache)
openlore analyze
openlore export bundle                       # → .openlore/index-bundle.olbundle

# Consumer: a teammate or CI bootstraps an integrity-checked index without re-analyzing
openlore import .openlore/index-bundle.olbundle
```

## The artifact

`openlore export bundle [--out <path>] [--sign-key <pkcs8.pem>]` serializes the persisted index under `.openlore/analysis/` into a
single, compact, self-describing file (default `.openlore/index-bundle.olbundle`). It is a gzipped JSON
envelope of:

- a **manifest** — the bundle format version, the OpenLore version, the index **schema version**, the
  **source commit** and analyzed tree state (`clean`, `dirty`, or `unknown`), the bundled **integrity attestation** (committed
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

**Optional producer authentication.** `--sign-key` accepts an unencrypted Ed25519 PKCS#8 private
key. The v2 bundle carries a detached signature that binds every trust-relevant manifest claim and
the payload digest. Import verifies it only against inline Ed25519 SPKI public keys explicitly
listed in `bundle.trustedSigners`; unsigned bundles remain supported but are always disclosed as
`provenance UNVERIFIED`. A present invalid or untrusted signature is rejected (exit `2`), never
downgraded to unsigned or converted into a rebuild.

## Import is validate-or-rebuild (safe by construction)

`openlore import <artifact>` separates payload integrity, producer provenance, and source currency. It runs
this ladder and, on unsigned integrity/currency failure, degrades transparently to a full local rebuild — so import
never leaves you worse off than having no artifact:

| # | Check | Failure → |
|---|-------|-----------|
| 1 | Bundle format version compatible | rebuild |
| 2 | Index schema version matches this OpenLore | rebuild (`mismatched`) |
| 3 | Payload byte-integrity (corrupt / hand-edited / line-merged) | rebuild |
| 4 | Graph-content digest == bundled attestation, store reconciles healthy | rebuild (tampered) |
| 5 | Present signature validates against `bundle.trustedSigners` | reject on invalid/untrusted |
| 6 | **Currency** vs. the working tree (below) | see below |

Currency outcomes once the artifact has validated:

- **clean analyzed tree + commit == HEAD** → imported as-is and current versus that commit. An
  unsigned bundle still says `provenance UNVERIFIED`; only a trusted signature earns
  `provenance verified`.
- **dirty analyzed tree + commit == HEAD** → imported as approximately current, with the dirty
  build disclosed.
- **locally dirty checkout + commit == HEAD** → imported as approximately current, even when the
  producer analyzed a clean tree; local edits can make the imported graph incomplete.
- **legacy/unknown analyzed tree + commit == HEAD** → imported with currency unknown; missing
  state never means clean.
- **no git repo / no recorded build commit** → imported as-is, but currency is **disclosed as
  UNVERIFIED** (run `openlore analyze` if the source has changed).
- **clean stale ancestor** → the validated bundle is applied in staging, then the exact Git delta
  (including local tracked and untracked changes) is intersected with the configured analysis corpus
  and passed through the watcher's bounded converge-or-flag path. The receipt reports delta size,
  closure size, and any explicitly stale remainder.
- **dirty/unknown ancestor, changed analysis configuration or ignore rules, configured include
  patterns not represented by a legacy bundle fingerprint, oversized/truncated delta, or
  diverged/unknown history** → **full local rebuild**. These cases cannot prove an exact baseline or
  bounded corpus, so import does not guess.

Any *unexpected* failure during materialization or validation (e.g. a structurally-valid bundle whose
`call-graph.db` turns out to be corrupt) also degrades to a rebuild rather than crashing the command.

Analysis brackets extraction with full-HEAD and working-tree observations. A generation is stamped
`clean` only when both endpoints name the same commit and both are clean; transitions and Git
failures are recorded as `dirty` or `unknown`, never guessed clean.

On a successful as-is import, any **stale search index** from a prior index in the target directory
(`vector-index/`, `text-line-index/`) is cleared first — its embeddings would otherwise describe a graph
that no longer matches — and the keyword (BM25) index is rebuilt for the imported graph.

**What works immediately after import.** Everything that reads the call graph — `orient`, `search_code`,
`search_specs`, `analyze_impact`, `find_path`, `blast_radius`, `select_tests`, `report_coverage_gaps`, and
the rest — works right away on a successful import, no re-analyze: the keyword (BM25) code and spec search
indexes are rebuilt on import over the full symbol set. Two things are *not* restored on import and wait for
the next `openlore analyze`: *semantic* (embedding) search (opt in any time with `openlore embed --local`),
and the literal-text line index (`text-line-index/`). Everything else matches a fresh analyze.

**Exit codes.** `export` and `import` exit `0` on success — and import exits `0` on the rebuild path too,
since a rebuild is a successful outcome, not an error. A genuine *user* error exits `2`: an artifact path
that doesn't exist, a file that isn't an OpenLore bundle at all (wrong path / not a `.olbundle`), or `export`
run before `openlore analyze` (no index to bundle). These are clean errors, never a silent rebuild.

**Untrusted-input safety.** A `.olbundle` is treated as untrusted on-disk input. Import rejects a file over
64 MiB before reading it and caps decompression at 96 MiB — about 1.7× the 58,717,652-byte expanded
bundle measured for this repository — so a crafted bundle cannot expand without bound
(compression-bomb guard). Every bundled file name must be a plain basename: a payload entry containing a path
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

Turn per-run cold indexing into a validated import plus (at most) a rebuild. Because import checks
against the checked-out commit, it is safe to run unconditionally:

```yaml
# .github/workflows/ci.yml (excerpt)
- name: Bootstrap OpenLore index
  run: |
    if [ -f .openlore/index-bundle.olbundle ]; then
      npx openlore import .openlore/index-bundle.olbundle   # validated import, or transparent rebuild
    else
      npx openlore analyze
    fi
```

If the committed artifact is at the CI checkout's commit, import is a fast file-materialization with
separate integrity, provenance, and currency receipts. If a clean artifact lags on the same history,
import catches up the bounded source delta; larger or unverifiable gaps rebuild.

## What this is not

- Not a new on-disk graph schema and not a graph merge algorithm — it exports the existing index and
  regenerates on divergence.
- Not a hosted cache or registry — it is git-distributed and offline.
- Not a way to serve undisclosed stale state — bounded catch-up either converges or names its
  explicit-stale remainder; unsafe corpus or history changes rebuild.

Deferred follow-up: cross-repo/federated bundles (federation already has its own index-of-indexes).
