# Tasks — ground-generated-specs-in-the-graph (narrowed)

## Implementation

- [x] Generator writes the implementation anchor after the `SHALL` line at every emission site
- [x] `verifyRequirementAnchors` writes no anchor for a key whose proposals name different symbols
- [x] `parseSpecRequirements` skips anchor, multi-token continuation, and provenance-blockquote lines;
      a normative blockquote stays the description
- [x] `not-assessed` anchor and requirement state with `boundary`; `stats.notAssessed`; index v7;
      the artifact reader accepts the state
- [x] `buildFileAssessor`: `language-not-extracted`, `file-not-analyzed` — only for an analyzed or
      existing regular file, by real path (parse health withdrawn as a boundary after review)
- [x] Cache served only when re-assessing its `stale`/`not-assessed` anchors agrees
- [x] `extractsExports` shares the import parser's file-type function
- [x] `mapping refresh` prints the count and lists not-assessed anchors with boundaries
- [x] `orphanRequirementsOf` excludes not-assessed requirements
- [ ] ~~`#### Requirement:` recovery and sub-component anchors~~ — withdrawn after review (see proposal)
- [ ] ~~Parallel grounding checker, overallScore unblend, vocabulary mapping~~ — superseded
- [ ] ~~Multi-symbol writing, slice recording, finding code, rename bridging, no-key clause~~ — deferred

## Verification

- [x] Verifier parser test: SHALL text past a multi-token anchor and decision blockquote; normative
      blockquote kept; `####` not recovered
- [x] Generator test: anchor after `SHALL`
- [x] Link-index tests: `not-assessed` with boundary; path-free absent anchor stays `stale`; `stale`
      outranks `not-assessed`; no assessor preserves prior behavior; `####` not indexed; artifact
      round-trip accepts `not-assessed`
- [x] Assessor tests: each boundary; nonexistent, extensionless, and directory paths are not
      boundaries; symlink and case spellings resolve to the analyzed file
- [x] Cache test: `stale` served from cache, then rebuilt as `not-assessed` when the cited file appears
- [x] Ambiguous outranks not-assessed; not-assessed is never an orphan; refresh output lists boundaries
- [x] Collision test: colliding proposals write no anchor
