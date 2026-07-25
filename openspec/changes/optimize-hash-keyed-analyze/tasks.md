# Tasks — optimize-hash-keyed-analyze

## Implementation
- [ ] Fact-cache table in EdgeStore: `(file_path PK, content_hash, extractor_stamp, facts JSON)`
      storing Pass 1 output (nodes, raw edges, CFG, import facts, parse-health) per file;
      read/write API beside `getFileHash`/`setFileHash` (`edge-store.ts:927-940`)
- [ ] Shared extractor-version stamp module (coordinate with `add-incremental-early-cutoff`'s
      digest module — one implementation; tokenizer-version-stamp precedent)
- [ ] Analyze gate: replace the all-or-nothing fingerprint skip (`analyze.ts:411-412`) with
      per-file hash diff → partition {reuse, re-extract, drop}; `--force` bypasses then
      repopulates
- [ ] `CallGraphBuilder.build` accepts pre-supplied cached facts for the reuse partition and
      runs Pass 1 (pool or serial) only over the re-extract partition; Pass 2+ unchanged over
      the merged set
- [ ] Scope `clearAll` (`edge-store.ts:989`): ordinary rebuild patches; only schema/stamp bump
      or `--force` clears the fact cache
- [ ] Summary disclosure: `re-extracted N, reused M` in the analyze epilogue (CLI + embedded)

## Verification
- [ ] Byte-equality oracle: after an edit sequence (edit, add, delete, rename), cached-lane
      artifacts byte-identical to `analyze --force` on the same tree
- [ ] One-file-edit test: exactly one file re-extracts (instrument extraction calls)
- [ ] Stamp-bump test: v1 facts never reused under v2
- [ ] Deleted-file test: no ghost nodes/edges/CFG rows survive
- [ ] Watcher interop: a daemon-patched graph and a subsequent batch analyze converge to the
      same artifacts (converge-or-flag guarantee preserved across the boundary)
- [ ] Measure and report analyze wall-clock on this repo for a 1-file diff vs `--force`; no
      unmeasured claims
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD AnalyzeCostScalesWithTheDiff
