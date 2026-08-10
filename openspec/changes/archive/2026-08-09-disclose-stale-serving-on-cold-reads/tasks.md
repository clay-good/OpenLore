# Tasks — disclose-stale-serving-on-cold-reads

## Implementation

- [x] Extract the dual-baseline freshness check (content-hash else mtime) from the span
      locator into a shared, dependency-light helper (`freshness.ts`); span locator delegates
      to it (behavior unchanged)
- [x] Wire the helper into the conclusion handlers that cite files, scoped to cited files
      only: orient first (highest first-run traffic), then search_code, get_subgraph,
      blast_radius; attach the staleness note field
- [x] CLI: `orient --json` payload field + `--inject` single-line disclosure inside the
      budgeted block (mandatory-line priority decision documented)
- [x] Repair handoff: when `--watch-auto`/serve is hosting, feed detected files to the
      existing stale-region path and switch the note to "repair scheduled"; one-shot CLI
      discloses only
- [x] Note the baseline gotcha: full analyze does not populate `file_hashes` in every path
      (span-locator finding) — the helper must keep the mtime fallback honest
- [x] Tests: cold-start stale fixture (edit after analyze, no watcher) → note present, results
      served; fresh fixture → no note; a deterministic hosted repair callback drives the
      stale-to-fresh transition, with watcher/serve scheduling covered separately; per-call
      cost bounded to cited files (no repo scan)

## Verification

- [x] Re-run the e2e repro: append `refundCard`, run `orient --json --task "refundCard
      behavior"` and a cold MCP `orient` — both disclose `src/payments.ts` staleness
