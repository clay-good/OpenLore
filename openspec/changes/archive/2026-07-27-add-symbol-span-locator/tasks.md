# Tasks — add symbol span locator (read-only)

## Implementation
- [x] `locate_symbol_span(symbol)` handler resolving via the `find_clones` `name::path` addressing
      (unknown → `not-found` + candidates; ambiguous bare name → `ambiguous` + `name::path`
      candidates; never a fuzzy guess)
- [x] Content-hash freshness verdict (`hashSpan` over the indexed span vs. current file bytes):
      match → `fresh` with the byte + line span; mismatch → `stale` with a re-analyze hint and no
      usable offset. Baseline is the index's per-file `content_hash` when present (authoritative),
      else the artifact-vs-source mtime — both fail safe toward `stale`
      (`FreshnessFailsSafeTowardDistrust`)
- [x] Register the tool: `TOOL_CAPABILITY_FAMILY` = `navigate`; `tool-contract.ts` class =
      `conclusion`; `readOnlyHint: true`; placed in `--preset full`. NOT added to `substrate` —
      the default surface is benchmark-gated (ADR-0023), so a new tool stays opt-in
- [x] NO write path, NO `edit` preset, NO mcp-security write-confinement change — the tool only
      reads

## Verification
- [x] Fixture: a fresh, unambiguous `name::path` symbol returns the byte-exact span + `fresh`
- [x] Verdicts: ambiguous bare name → `ambiguous`+candidates; unknown → `not-found`+candidates;
      changed-file span → `stale`+re-analyze hint — and no file is ever modified
- [x] Read-only guard: the handler performs no write (annotation + behavior asserted)
- [x] tools/list payload budget assertion bumped (88_000 → 90_000, documented); default-surface
      presets byte-identical (`substrate`/`navigation` unchanged)
- [x] Full suite green (`lint`, `typecheck`, `vitest run src examples`, `build`); E2E on OpenLore's
      own index: `hashSpan::…/anchor.ts` → `fresh` (lines 27-29, byte span slices to the function),
      a drifted file → `stale`, bare `build` → `ambiguous`, unknown → `not-found`

## Spec
- [x] `mcp-handlers` delta: ADD SymbolSpanLocatorReportsFreshnessVerdict (replaces the withdrawn
      SymbolAnchoredEditsRefuseStaleSpans)
- [x] `mcp-security` delta withdrawn — no write face, so no write-confinement extension
