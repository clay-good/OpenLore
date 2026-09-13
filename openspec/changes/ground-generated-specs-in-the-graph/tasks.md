# Tasks — ground-generated-specs-in-the-graph (narrowed)

## Implementation

- [x] Generator writes the implementation anchor after the `SHALL` line at every emission site
- [x] Generator anchors sub-component `#### Requirement:` blocks
- [x] `parseRequirementBlocks` recovers `#### Requirement:` blocks
- [x] `parseSpecRequirements` recovers `####` requirements and skips anchor, continuation, and
      blockquote lines when recovering a description
- [x] `not-assessed` anchor and requirement state with `boundary`; `stats.notAssessed`; index v7
- [x] `buildFileAssessor`: `language-not-extracted`, `parse-health-lower-bound`, `file-not-analyzed`
- [x] `extractsExports` derived from the import parser's dispatch
- [x] `mapping refresh` prints the count and lists not-assessed anchors with boundaries
- [x] `orphanRequirementsOf` excludes not-assessed requirements
- [ ] ~~Parallel grounding checker, overallScore unblend, vocabulary mapping~~ — superseded (see proposal)
- [ ] ~~Multi-symbol writing, slice recording, finding code, rename bridging, no-key clause~~ — deferred

## Verification

- [x] Verifier parser test: description is the `SHALL` text at both heading levels, past anchors,
      continuation lines, and blockquotes
- [x] Generator tests: anchor after `SHALL`; sub-component anchor emitted
- [x] Link-index tests: `####` block indexed; `not-assessed` with boundary; path-free absent anchor
      stays `stale`; `stale` outranks `not-assessed`; no assessor preserves prior behavior
- [x] Assessor test: each boundary named; an analyzed healthy file and a nonexistent file are not
      boundaries
