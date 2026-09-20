# Tasks

## 1. Overlay core

- [x] 1.1 Add a query-time overlay that takes the stale set from `freshness.ts` and returns
  re-extracted symbols, signatures, and spans through an in-process, path-aware memo;
  verify with a test that an added function in a dirty file appears and a deleted one disappears
- [x] 1.2 Verify the cache is honoured: assert no re-parse on a second query in the same session and
  none for files outside the stale set
- [x] 1.3 Add the file, byte and time bounds with a stated skip reason; verify each bound trips
  independently and that the skipped path returns today's answer plus the reason
- [x] 1.4 Handle an unparsable dirty file by reporting it as not overlaid; verify the query still
  answers

## 2. Row coherence and provenance

- [x] 2.1 Refresh surviving indexed rows from the overlay and suppress deleted symbols; verify current
  signatures and spans are served with an overlay label
- [x] 2.2 Label overlaid results with overlay provenance and verify it is distinguishable from
  indexed provenance in the structured output
- [x] 2.3 Mark the working-tree boundary incomplete when overlaid symbols retain indexed incoming edges

## 3. Handler integration

- [x] 3.1 Serve the overlay from `search_code` and `locate_symbol_span`; verify the separate disclosure
  names files read from source and files still served from the index
- [x] 3.2 Make `symbol-span` prefer overlaid spans and drop the untrustworthy-offset warning for
  covered files; verify the warning still appears when the overlay was skipped
- [x] 3.3 Disclose the edge-staleness limit when callers of an overlaid symbol are reported, and
  verify the disclosure appears in that case only

## 4. Verification

- [x] 4.1 End-to-end: edit a file, query without re-analyzing, and verify the answer reflects the
  edit and names its provenance
- [x] 4.2 Measure added latency for a 1-file, 10-file and over-cap stale set; verify the over-cap
  case matches current latency and record the numbers in the change
- [x] 4.3 Run `openspec validate --strict` and the reaching tests from `openlore select-tests`;
  verify both are green
