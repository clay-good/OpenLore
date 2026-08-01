# Tasks — add-log-anchor-conclusions

## Implementation
- [ ] Source-declared per-language logger pattern table (TS/JS/Python first; others fail-soft
      with no counters) + template extraction in the Pass-1 walk: constant parts, file, line,
      enclosing symbol, level when literal
- [ ] Sidecar template index, rebuilt incrementally with the owning file's facts; per-file
      unmatchable-boundary counts (fully dynamic messages)
- [ ] `locate_log_origin` handler + `openlore log-origin` CLI: ordered constant-part
      containment match, longest-matched-length candidate ordering, per candidate call site +
      enclosing function + backward paths + reaching tests
- [ ] Honesty paths: all surviving candidates returned with ambiguity reason; zero-candidate
      response carries the unmatchable count; static-templates-vs-deployed-version boundary
      named; index staleness disclosure carried
- [ ] Wiring checklist: conclusion classification (family `navigate`), `full` preset, Pi
      surfaced-or-excluded, lease weights, docs table row

## Verification
- [ ] Fixtures: template-literal match, printf-style match, multi-candidate ambiguity, fully
      dynamic message → boundary count, unsupported-language-only match disclosure
- [ ] Ordering is by total matched constant length (no tuning constant anywhere)
- [ ] Incremental: editing one file rebuilds only its templates
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD LogTemplatesAreExtractedInTheExistingWalk
- [ ] `mcp-handlers` delta: ADD LogOriginIsAConclusionWithDisclosedAmbiguity
