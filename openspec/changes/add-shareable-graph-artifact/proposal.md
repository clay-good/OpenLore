# Shareable graph artifact: a team indexes once, everyone (and CI) bootstraps from it — conflict-free

> Status: SHIPPED (2026-06-26). Part of the `STRUCTURAL-CONTEXT-PATTERNS.md` set. Depends on
> `add-index-integrity-attestation` (the integrity stamp is what a consumer validates; shipped PR #196).
> Adds a portable, schema-versioned, integrity-stamped export/import of the graph index plus a
> conflict-free git discipline, so a newcomer or a CI job bootstraps from a shared artifact instead of
> cold-indexing. No new dependency, no LLM, no new MCP tool.
>
> **Shipped as:** `openlore export bundle [--out <path>]` and `openlore import <artifact>`
> (`src/core/analyzer/index-bundle.ts` codec, `src/cli/export/bundle.ts`, `src/cli/commands/import.ts`).
> Docs: `docs/shareable-bundle.md`. Tests: `src/core/analyzer/index-bundle.test.ts`.
>
> **Implementation note — re-attest at export.** The bundle's attestation is recomputed from the live
> store at export time (not carried forward from the on-disk `index-attestation.json`), because the
> incremental watcher legitimately mutates the store between full builds and the on-disk digest is
> documented as "not a load-time driver." Re-attesting makes the import-time digest check a true tamper
> detector instead of a false positive on every incrementally-updated index.
>
> **Adversarial-review hardening (2026-06-26).** A second pass (adversarial code review + e2e fuzzing)
> closed: a **path-traversal arbitrary-write** on import (a crafted payload key like `../../x` wrote
> outside the target dir before any trust gate) — now every bundled file name must be a plain basename,
> rejected at parse before any write; a **crash-instead-of-rebuild** on a structurally-valid-but-corrupt
> bundle — the materialize/validate region now degrades to a rebuild on any unexpected error; a
> **manifest/payload mismatch** is rejected; the **attestation's inner fields** (digest, counts) are
> validated at the boundary, not relied on downstream; and the decompressed artifact is size-bounded
> (zip-bomb guard). Regression tests cover each. The graph (`call-graph.db`) is digest-validated against
> the attestation; other bundled artifacts are trusted to the bundle's source (documented).
>
> **Integration hardening (2026-06-26, round 3).** A final integration audit + e2e found that `orient` /
> `search_code` (the search-based tools) did NOT work on an imported index: the bundle excludes the LanceDB
> search index, and the only existing rebuild path (`openlore embed`) runs a FULL re-analyze — defeating the
> bundle's purpose. Fix: `import` now rebuilds the keyword (BM25) search index directly from the materialized
> graph (offline, ~150 ms, no source re-parse, no API), so a fresh import is functionally identical to a fresh
> `analyze` for every tool; semantic embeddings remain an opt-in `openlore embed --local`. Import also clears
> a prior index's stale `vector-index/` / `text-line-index/` (whose embeddings would mismatch the imported
> graph) and excludes `vector-index-meta.json` from the bundle. Verified e2e: fresh checkout → import → `orient`
> returns correct results with no re-analyze.
>
> **Fidelity hardening (2026-06-26, round 4).** A fidelity audit found the round-3 search-index rebuild
> was a *subset* of a fresh analyze: it passed `signatures=[]`, so ~997 non-callable symbols (constants,
> types, interfaces, enums with no call-graph node) were missing from the code index, and it never rebuilt
> the spec index, so `search_specs` was broken after import. Both are now closed using only bundled data +
> the checkout (no re-parse): `import` reads the per-file `signatures` the bundle carries in
> `llm-context.json` and the checked-out source for body text, so the code index matches a fresh analyze
> exactly (measured: 2735→3734 records), and it rebuilds the keyword spec index (`search_specs` works).
> Verified e2e: imported index has functions=3734 / specs=559 tables; `orient` returns code + matchingSpecs
> and finds non-function symbols. The only un-restored search feature is the literal-text `text-line-index/`
> (rebuilt by the next analyze) — documented.
>
> **Scope note — stale path.** A valid-but-ancestor-commit artifact degrades to a full local rebuild
> (the spec's sanctioned "or fall back to a full local rebuild"). Incremental-delta update of only the
> changed files is a deferred optimization; the headline win (verified, no-analyze bootstrap when the
> artifact's commit matches the working tree — the regenerate-don't-merge common case for CI and
> teammates) is delivered, and a stale artifact is never served as current.

## Why

Every machine that wants OpenLore's context pays the cold-index cost from scratch: a new teammate
clones the repo and waits for a full analyze before any tool answers; CI re-indexes on every run; a
large monorepo pays this repeatedly across a fleet. The graph is a *deterministic function of the
committed source* — so for a given commit, every machine computes the **same** index. Recomputing it
on each machine is redundant work, and the redundancy scales with team size.

OpenLore already persists the index under `.openlore/analysis/` and teams can commit it, but there is
no first-class story for *sharing it safely*. Two problems block naive "just commit the JSON": **(1)
merge conflicts** — the index is a large generated artifact; two branches that both re-analyzed will
conflict line-by-line, and a hand-merged graph is a corrupt graph; and **(2) trust** — a committed
index can be stale (built at a different commit), built at an incompatible schema version, or simply
wrong, and a consumer has no way to know before relying on it.

A peer system solves both directly: it exports the graph as a compact, **schema-versioned** artifact
with an integrity manifest, marks the artifact in git as **regenerate-don't-merge** so it never
produces a conflict, and on import **validates the artifact and falls back to a local rebuild** if it
does not match. The newcomer/CI experience becomes "import the shared artifact, verified, in
seconds — or transparently rebuild if it's stale." We adopt this, reusing the integrity attestation
from proposal 3 as the trust stamp.

## What changes

1. **A portable graph artifact (`export` / `import`).** A CLI verb produces a single, compact,
   self-describing artifact bundling the persisted graph plus the integrity attestation (proposal 3):
   the schema version, the source commit it was built from, the committed artifact counts, and the
   content digest. A companion verb imports it, materializing the index locally without re-analyzing.

2. **Validate-or-rebuild on import (trust).** Import SHALL be safe by construction. The consumer
   validates the artifact before trusting it:
   - **schema version** matches this OpenLore's index schema, else reject (an artifact from an
     incompatible version is `mismatched`, never silently loaded);
   - **content digest** matches the bundled attestation, else reject (a corrupt/tampered artifact);
   - **source commit** is checked against the working tree. If the artifact's commit matches `HEAD`,
     it is imported as-is. If it is stale (built at an ancestor commit), the consumer MAY import it and
     then **incrementally update** only the files changed since, or fall back to a full local rebuild —
     never serve a stale artifact as if current. A validation failure of any kind degrades to a local
     rebuild, transparently, so import never leaves the consumer worse off than no artifact at all.

3. **Conflict-free git discipline (regenerate, don't merge).** The change documents and tooling-
   supports treating the committed artifact as a **generated, merge-as-regenerate** file: the recommended
   `.gitattributes` entry marks it so git never attempts a line-merge, and the canonical resolution for
   a divergence is "re-export at the merge commit," not a manual merge. A hand-merged graph artifact is
   prohibited by contract (it would be a corrupt graph); the integrity check on the next import would
   catch it as `mismatched` regardless. This is the same posture OpenLore takes elsewhere: a generated
   artifact is regenerated, never edited by hand.

4. **CI bootstrap path.** A CI job SHALL be able to import the shared artifact, validate it against the
   checked-out commit, and either use it directly (commit matches) or incrementally update it (stale) —
   turning per-run cold indexing into a verified import plus a small delta. The behavior is deterministic
   and offline; no network or service is involved.

5. **Determinism & honesty.** The artifact is a byte-stable function of the index it exports; export of
   the same index twice is identical. Validation outcomes are deterministic. The artifact never claims
   currency it cannot prove — a stale or mismatched artifact is updated or rebuilt, never served as
   fresh.

## Decision

**The artifact is the existing index plus the attestation, made portable — not a new graph format, and
not a merge protocol.** Export serializes the already-persisted graph and bundles proposal 3's
attestation as the trust stamp; import is validate-or-rebuild. We deliberately do not invent a
three-way merge for graphs (a merged graph is unsound) — the "merge strategy" is *regenerate*, enforced
socially by `.gitattributes` and structurally by the import-time integrity check that rejects anything
hand-edited or version-skewed. Sharing is opt-in (a team chooses to commit/distribute the artifact);
nothing about default single-machine operation changes.

## Scope contract — do not break these things

This change must NOT:
- Invent a new on-disk graph schema or a graph merge algorithm. Export the existing index; regenerate
  on divergence.
- Serve a stale or schema-mismatched artifact as current. Validate-or-rebuild is mandatory; a failed
  validation degrades transparently to a local rebuild.
- Require a network service, registry, or remote. Export/import are local, offline, deterministic.
- Change default single-machine behavior. Sharing is opt-in.
- Allow a hand-merged artifact to be trusted. The integrity check rejects it as `mismatched`.

## Out of scope (deferred)

A hosted/remote artifact cache or registry (this is git-distributed and offline); incremental *export*
deltas (export is whole-artifact; the stale-import path uses the existing incremental analyzer);
signing/provenance of the artifact beyond the content digest; and cross-repo/federated artifact bundles
(federation already has its own index-of-indexes; a federated bundle is a later change).

## Implementation status

Tracked in `tasks.md`. Verified by a round-trip test (export → import on a clean checkout reproduces an
index identical to a fresh local analyze), a stale-artifact test (import at an ancestor commit updates
incrementally to match a fresh analyze), a version-skew test (an artifact at an incompatible schema is
rejected and falls back to rebuild), and a tamper test (a digest mismatch is rejected).
