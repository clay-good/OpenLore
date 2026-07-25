# Tasks — harden-serve-descriptor-trust

## Implementation
- [x] Extract the descriptor validator from `serve.ts:247-271` into a dependency-light
      shared module (loopback-only host via `isLoopbackHost`, integer port 1-65535,
      integer pid > 0, token absent-or-string); `serve.ts` `readDescriptor` delegates to
      it with behavior unchanged (keeps its startedAt/version normalization)
- [x] `serve-client.ts` `readDescriptor` (:56-62): replace the raw
      `JSON.parse(...) as ServeDescriptor` cast with the shared validator; an invalid
      descriptor returns null (treated as absent → existing spawn / in-process fallback)
      with a debug-level disclosure, never a followed endpoint
- [x] `pi/extension.ts` `readDescriptor` (:400-404): same replacement; confirm the module
      stays dependency-light per the parity doctrine (Pi host must not import the analyzer)
- [x] Grep-audit for any other serve.json reader (none known beyond the three); add a test
      pinning that every reader resolves descriptors through the shared validator

## Verification
- [x] Poisoned-descriptor test per reader: serve.json with a non-loopback `host` (e.g.
      `169.254.169.254`, an intranet name), out-of-range/non-integer `port`, non-integer
      `pid`, or non-string `token` → reader returns null; no fetch is issued (assert via a
      mocked/instrumented fetch)
- [x] Fallback test: with an invalid descriptor on disk, `ensureServeDaemon` behaves as if
      no descriptor existed (spawns when allowed, returns null when `spawn:false`), and the
      MCP dispatch path (`mcp.ts:2566`) falls back to in-process — no tool call reaches the
      poisoned endpoint
- [x] Round-trip test: the descriptor `serve` actually writes passes the shared validator
      (no false rejection of a healthy daemon); existing serve.json validation tests
      (`serve.ts:245` notes they exist) still pass against the delegating reader
- [x] `serve stop` / status paths unchanged: guarded reader behavior identical before and
      after the extraction
- [x] Full suite green

## Spec
- [x] `mcp-security` delta: ADD ServeDescriptorValidatedAtEveryReader
