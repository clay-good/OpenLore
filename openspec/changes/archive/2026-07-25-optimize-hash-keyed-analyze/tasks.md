# Tasks — optimize-hash-keyed-analyze

## Implementation
- [x] Fact-cache table in EdgeStore: `pass1_facts (file_path PK, content_hash, extractor_stamp,
      facts JSON)` storing Pass 1 output (nodes, raw edges, CFG, style, parse-health) per file;
      read/write/prune API beside `getFileHash`/`setFileHash`
- [x] Extractor-version stamp (`pass1-fact-cache.ts`): a digest over the extraction code roots
      plus the installed grammar package versions — derived from evidence, not hand-bumped
- [x] Analyze gate: the builder partitions {reuse, re-extract} by content hash before the
      extraction lane runs; `--force` (and `OPENLORE_NO_FACT_CACHE`) bypasses reads then
      repopulates, and the epilogue names the CAUSE when nothing was reused
- [x] `CallGraphBuilder.build` accepts a `pass1Cache`; the reuse partition is spliced back into
      input positions so the merge loop (and every determinism property it owns) is unchanged.
      Pass 2+ unchanged over the merged set
- [x] Scope `clearAll`: the graph rebuild patches the memo (replace re-extracted, prune deleted)
      instead of destroying it; a SCHEMA_VERSION bump still drops it
- [x] Summary disclosure: `re-extracted N file(s), reused M cached` in the analyze epilogue
- [x] Re-extraction is its OWN lever, not an overload of `force`: `force` keeps its existing
      "do not skip this run" meaning for the serve daemon's post-edit rebuild and the
      watcher's heal (both of which want the memo), and `analyze --force` sets both
- [x] The exported bundle strips the memo: it is a local build cache, not graph data, and it
      was ~44% of the compressed payload

## Verification
- [x] Byte-equality oracle, end to end through the real pipeline: after edit / add / delete /
      rename, the reused lane's artifacts are byte-identical to `analyze --force`
- [x] One-file-edit test: the extraction lane is INSTRUMENTED and receives exactly the one
      changed file
- [x] Stamp-bump test: rows written under another stamp are never served
- [x] Deleted-file test: no ghost nodes survive and the memo row is pruned
- [x] Hostile-row test: a row whose content hash does not match the file on disk is not served
- [x] Watcher interop: a daemon-patched graph and a subsequent batch analyze converge to the
      same artifacts (the memo is keyed by current bytes, so a patched file misses and
      re-extracts; the converge-or-flag guarantee is unchanged across the boundary)
- [x] Unproven-silence guard: an extraction that produced NO facts at all — the shape an
      unloadable grammar returns — is never memoized, so a broken environment cannot freeze an
      empty graph into the cache
- [x] Stamp-coverage guard: the real static import closure of the extraction entry point is
      walked and every module must sit under a stamped root
- [x] Mutation-checked: a content-blind key, a stamp-blind lookup, and a path-only lookup each
      fail the suite
- [x] Measured on this repo (977 files, 792 extracted): `--force` 45.3/47.2/48.3/54.4s vs.
      reused 36.4/38.9/39.3/39.4s — the memo removes the whole Pass-1 extraction cost
      (~9s after the worker pool). The remaining time is the other whole-corpus passes, which
      this change deliberately does not touch
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD AnalyzeCostScalesWithTheDiff
