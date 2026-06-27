# Tasks — Trust-calibrated context economy

> IMPLEMENTED on the recall path (PR #161, decision `61c2ea7d`). Steps 1–3, 5 complete; step 4
> (benchmark) deferred. `orient` excluded (no memory surface yet). Depends on
> `harden-memory-integrity-invariant` (done) for the `fresh` verdict that gates certificates.

## 1. Grounding certificate on fresh facts
- [x] Attach `{ symbol, filePath, lineSpan, contentHash }` to each `fresh` fact returned by `recall`
      (via `AnchorContext.certificateForAnchor`). Reuses the freshness span hash; `lineSpan` computed
      from byte offsets against the live file (store keeps offsets, not lines). `orient` deferred — no
      memory surface.
- [x] Guard: only `fresh`, anchored facts (graph available) get a certificate; drifted/orphaned never.
- [x] Test: the certificate's `contentHash` matches an independent hash of the cited span.

## 2. Verified-current marker
- [x] Mark `fresh`-with-certificate facts `verified-current` (re-read unnecessary).
- [x] Test: `drifted` / `orphaned` (and graph-unavailable) facts never carry `verified-current`.

## 3. Tiered, budget-aware recall
- [x] Add optional `tokenBudget` to `recall`; return the highest grounding-density facts first
      (verified-current core, ≥1 always), then the tail as budget allows. Grounding density =
      verified-current ordering (salience-label ordering deferred, decision `61c2ea7d`); budget =
      caller input, no hidden weight. Threaded through dispatch + the recall MCP schema.
- [x] When the budget truncates the tail, report the withheld count (no silent cap).
- [x] Test: a tight budget returns core and reports the withheld count; no budget returns the full set.

## 4. Measure the lever (honest scorecard)
- [x] DONE (PR #168, ADR-0018): `bench:agent` reports re-read avoidance + the read-token delta + the
      certificates delivered, SEPARATELY per repo tier (`small-familiar` vs `large-unfamiliar`), so the
      +43% small-repo case is tracked rather than hidden. The live arm now captures the tool transcript
      (`--output-format stream-json`); the re-read extractor is a pure, CI-tested module
      (`src/bench/transcript-metrics.ts`, `transcript-metrics.test.ts`); repos carry a `tier`
      (`bench-agent.tasks.ts`); the report degrades to "no data" rather than fabricating when no live
      transcript is present. Validated end-to-end via `bench:agent --dry-run` (synthetic, both arenas).

## 5. Surface + contract discipline
- [x] No new tool; capability rides `recall` fields and the `tokenBudget` param. Manifest kept under
      the spec-28 char budget (recall description trimmed; certificate is self-documenting in output).
- [x] `tool-contract.ts` classification stays `conclusion` (recall unchanged in kind).

## 6. Docs
- [x] Documented the grounding certificate, `verified-current`, and budgeted recall in the
      `mcp-handlers` spec delta; deviations recorded in the proposal's Implementation status.
