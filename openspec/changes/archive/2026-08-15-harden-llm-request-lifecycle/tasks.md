# Tasks — harden-llm-request-lifecycle

## Implementation
- [x] `executeWithTimeout`: AbortController per request; abort on
      timeout, `clearTimeout` on settle (success and failure)
- [x] Thread the AbortSignal into every provider `fetch` (Anthropic, OpenAI,
      OpenAI-compatible, Copilot, Gemini) and into the SSE reader loop so
      an abort stops the read, not just the caller's await
- [x] Replace the hardcoded provider ceilings (4,096; Gemini 8,192) with per-provider
      constants in `src/constants.ts`, following the existing
      `CLAUDE_MAX_OUTPUT_TOKENS` pattern
- [x] `completeJSON` correction request: inherit the original
      request's `maxTokens`; validate the corrected content against the original
      `jsonSchema` when one was supplied
- [x] Truncation choke point: in the LLM service response path, warn when
      `finishReason === 'length'` (cap value + purpose in the message) — single site, not
      per caller
- [x] `getKnownModelsForEndpoint`: list only ids consistent with the OpenAI-compatible
      pricing-table keys; drop invented/stale ids; keep the honest empty return for
      unknown or differently priced endpoints. This helper is dormant and remains unwired
      by this change

## Verification
- [x] Test: a timed-out request aborts the underlying fetch (mock fetch observes the signal
      firing) and the stream reader stops
- [x] Test: a successful request leaves no pending timer (fake timers; no dangling timeout)
- [x] Test: with no caller `maxTokens`, each provider resolves its ceiling from the
      constants path, not a provider-local literal
- [x] Test: `finishReason: 'length'` produces exactly one warning through the service funnel
- [x] Test: every id returned by `getKnownModelsForEndpoint` for a priced endpoint resolves
      in the pricing table (consistency guard, so the two can't drift again)
- [x] Full suite green (7,603 passed / 2 skipped with one worker); no behavior change on
      non-timeout happy paths

## Spec
- [x] `llm` delta: ADD TimeoutCancelsTheUnderlyingRequest, OutputTokenCeilingSingleSourced,
      KnownModelCatalogConsistency
