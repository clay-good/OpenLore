# Tasks — harden-llm-log-and-telemetry-honesty

## Implementation
- [x] LLM log: apply the shared redactor to `response` as well as `request`
      (llm-service.ts:1786-1795); record the redaction count in the entry
- [x] LLM log: add rotation/retention cap matching telemetry (50MB × N); gate enableLogging
      behind a disclosed config/flag OR print a one-line first-write notice at all 11 call
      sites (six CLI paths: verify/drift/run/decisions/generate/test; five API paths:
      verify/drift/run/decisions/generate)
- [x] Telemetry gate fix (telemetry.ts:44): enable only when value === '1' (documented
      truthy set excluding '0'/'false')
- [x] Widen telemetry disclosure in README:395 + the file header: enumerate recorded domains
      (tool calls, agent id, latency, error strings, decision titles, lease events); note
      local-only/gitignored/rotated
- [x] Fix cache_read hit/miss label (utils.ts:396) emitting hit:true on the miss path

## Verification
- [x] Gate test: OPENLORE_TELEMETRY=0 disables telemetry; =1 enables
- [x] Log-redaction test: a response containing a fake secret is scrubbed in the written
      llm-log JSON with the count recorded
- [x] Retention test: oldest owned log files are pruned past the count or byte cap
- [x] Disclosure test/doc check: README enumerates the recorded domains
- [x] Full unit and E2E suites green (timing-sensitive stress cases re-verified serially)

## Spec
- [x] `mcp-security` delta: ADD LlmLogPersistenceIsDisclosedRedactedAndBounded
- [x] `cli` delta: ADD TelemetryGateAndDisclosureAreHonest
- [x] `api` delta: MODIFY Postspecverification so log persistence is exact opt-in
