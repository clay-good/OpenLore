# Tasks — parse-health boundary disclosure

## Implementation
- [x] Per-file parse-health record captured during the AST walk: hasError, ERROR/MISSING counts +
      line spans, parse failure, encoding fallback (new leaf module `parse-health.ts`;
      `tallyParseHealth` fast-paths clean trees; sound lower bound — spurious `hasError` dropped)
- [x] Replace bare `catch {}` per-file swallow (call-graph.ts build dispatch) with a structured
      parse-failure record (still fail-soft — never aborts the build)
- [x] Persist with analysis artifacts (`parse-health.json`, absent on a clean repo); watcher
      maintains per changed/deleted file (creates when first degraded, removes when repaired)
- [x] `get_language_support` + `orient`: compact parseHealth summary / per-conclusion boundary
- [x] `doctor`: degraded-files check (`Parse health`)
- [x] Conclusion tools: boundary entry when the result set touches a degraded file (`find_dead_code`,
      `orient`); shared `parse-health-boundary.ts` helper
- [x] Register `parse-health` finding code (advisory default) in FINDING_CODE_REGISTRY
- [x] Conformance canary: native-grammar fixtures must parse with zero ERROR/MISSING nodes
- [x] MCP↔Pi parity: the `orient --inject` renderer surfaces the boundary line
- [~] Size-cap exclusion — NOT applicable: the call-graph read path reads files in full (no size
      cap excludes extraction), so there is nothing to disclose. Recorded honestly rather than
      implemented against a non-existent exclusion.
- [~] WASM grammars (Lua, Dart) are fail-soft for parse-health — their shared WASM `Language` heap
      yields spurious ERROR nodes on parses after the first, so `hasError` is untrustworthy there.
      Excluded (never a false positive), disclosed in the loader + spec. (The underlying WASM
      lifecycle bug is pre-existing and left to a dedicated grammar-loader hardening change.)

## Verification
- [x] Fixture with a deliberate syntax error: symbols before the error still extracted; parse-health
      record emitted (`parse-health.test.ts` build integration)
- [x] `hasEncodingFallback` detects U+FFFD; boundary describes it
- [x] Clean file: no record; clean repo: no artifact, no boundary, no payload growth
- [x] Full suite green; MCP payload budget respected

## Spec
- [x] `analyzer` delta: ADD ParseHealthIsRecordedAndDisclosed
- [x] `mcp-handlers` delta: ADD ConclusionsDiscloseParseHealthBoundaries
