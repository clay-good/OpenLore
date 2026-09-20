# Tasks — add-symbol-content-hashes

Narrowed at build time (see proposal "Build notes"): hashes are computed at query time for the
diff's files only, not persisted at analyze; the change-coupling semantic-churn view is deferred.

## Implementation
- [x] Normalized hash over each symbol's parse subtree on the extractor's existing parse
      (`analyzer/symbol-content-hash.ts`; node types + leaf texts + open/close markers, comments
      excluded unless they are directives from a closed cross-language list, uncovered text hashed,
      module-level residual + per-import hashes + a layout of the file's runs), opt-in via
      `withContentHashes` so analyze never pays for it; native extractors only (WASM and script
      containers return none)
- [x] Changed-set module (`services/symbol-changed-set.ts`): both sides extracted for the diff's
      files only (merge base via `git cat-file`, working tree via a confined read), hash-set diff
      (changed / appeared / disappeared), continuity-carried renames, sound file-granular fallbacks
      with a closed reason vocabulary, same-file referencing and dynamic-dispatch symbols kept
- [x] Consumers: `select_tests`, `blast_radius`, `briefing_since` seed from the changed-set and
      carry a `changeGranularity` receipt and caveat; `briefing_since` lists `carried` renames and
      drops the blanket file-granularity caveat
- [x] Fallback disclosure: every file that stays file-granular is named with its reason, and no
      consumer claims "unchanged" over a file it did not hash or a symbol the index does not know
- [x] Bounds that cannot become an outage: file, per-file byte, cumulative byte and wall-clock
      budgets, a size probe before any read (one `git ls-tree -r --long -z`), non-regular
      working-tree entries refused rather than blocking on open
- [ ] Deferred: persisted `norm_hash` column (until early cutoff needs it); change-coupling
      semantic-churn view (needs per-commit re-extraction); rename-aware churn join

## Verification
- [x] Formatting/comment-only edit → identical normalized hash → empty changed-set; raw `hashSpan`
      still changes
- [x] One-function edit in a ten-function file → changed-set contains exactly that symbol
- [x] Rename-only edit → carried pair, not changed+new
- [x] Python dedent out of a block → changed; template-literal whitespace → changed; Go directive →
      changed
- [x] Module-level change, reorder, parse errors, unreadable base, index mismatch, file cap →
      file-granular with the reason
- [x] Subdirectory analysis roots and renamed files map correctly
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD NormalizedSymbolContentHashes, SymbolLevelChangedSets
