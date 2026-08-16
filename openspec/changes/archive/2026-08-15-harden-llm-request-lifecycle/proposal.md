# Harden the LLM request lifecycle: a timeout must cancel the request, not abandon it

> Status: **BUILT** (2026-08-15). Full suite green (7,603 passed / 2 skipped), focused
> LLM suite green (134 passed / 2 skipped), build, lint, typecheck, strict OpenSpec
> validation, and integration suite green (185 tests).
> Three multi-agent adversarial review loops found and closed cancellation cleanup,
> provider-limit, endpoint-spoofing, test-coverage, and specification-honesty gaps.
>
> Originally proposed 2026-07-03 (e2e audit pass 3). Four verified defects in the opt-in LLM
> layer: a timeout that races but never aborts (the HTTP request and stream keep consuming
> tokens after the caller gave up, and the timer leaks on success), provider output caps
> hardcoded at 4,096 or 8,192 instead of following the constants path, a `finishReason` truncation signal every
> provider computes but no pipeline inspects, and a dormant known-model catalog helper
> containing invented model ids. Abort-wire the timeout, single-source the output ceiling, surface truncation
> at one choke point, and make the catalog consistent with the pricing table.

## The gap

- **(a) Timeout without cancellation.** `executeWithTimeout` in `llm-service.ts`
  races the provider promise against a bare `setTimeout` reject. No `AbortController` or
  `AbortSignal` exists anywhere in the file (one grep hit, a comment), so on timeout the
  fetch and the SSE read loop in `OpenAICompatibleProvider` (with no per-read idle
  timeout) keep running — consuming tokens, cost, and sockets after the caller has already
  thrown. And the `setTimeout` is never `clearTimeout`'d on success, so every successful
  call leaves a dangling timer in the long-lived MCP server.
- **(b) Output ceiling split-brained.** HTTP provider output ceilings are hardcoded in
  `llm-service.ts` (4,096 for Anthropic, OpenAI, OpenAI-compatible, and Copilot; 8,192 for
  Gemini), while `CLAUDE_MAX_OUTPUT_TOKENS` already establishes a constants-backed pattern
  for `ClaudeCodeProvider`. The JSON correction request inside `completeJSON` sets neither
  `maxTokens` nor `jsonSchema`, so a large correction can silently fall to the provider
  default before `JSON.parse` and schema validation.
- **(c) Truncation computed, never inspected.** Every provider computes `finishReason`, but
  outside the interactive chat agent no
  caller in the generate/verify/decisions pipelines reads it — a `length` stop is
  indistinguishable from a clean one. (The parsing side — refusing to silently drop
  truncated structured output — is the companion change `harden-llm-output-contract`;
  THIS change makes the signal available and warned.)
- **(d) Invented model ids in a dormant helper.** `getKnownModelsForEndpoint` contains
  Mistral and Groq ids that match nothing in the service's own pricing table. The helper
  and sibling `/models` fetch are currently private and unwired, so this is not a claim
  about a live model picker; hardening the helper prevents those guesses from becoming a
  future runtime contract.

## What changes

1. **Abort-wired timeout.** `executeWithTimeout` creates an `AbortController`, passes its
   signal through every provider `fetch` and into the streaming reader, aborts on timeout,
   and `clearTimeout`s on settle — no work after the caller gives up, no leaked timers.
   Deterministic plumbing; the existing `retryConfig.timeout` value is reused unchanged.
2. **One authoritative output-token path.** Per-provider default output ceilings come from
   one constants-sourced path (as `ClaudeCodeProvider` already does via
   `CLAUDE_MAX_OUTPUT_TOKENS`) instead of provider literals; the `completeJSON`
   correction request inherits the original request's `maxTokens` (and schema check) rather
   than silently falling to the floor.
3. **Truncation surfaced at one choke point.** The LLM service (the single funnel every
   provider response passes through) logs a warning when `finishReason === 'length'`,
   naming the request purpose and the cap — callers and logs see truncation instead of
   inferring it from downstream parse failures.
4. **Honest known-model catalog helper.** `getKnownModelsForEndpoint` lists only ids
   consistent with the OpenAI-compatible pricing table's exact keys, or returns none for
   unknown or differently priced endpoints — never an invented id.

## Why this is in scope

The LLM layer is OFF the hot path by doctrine — generate/consolidate only; nothing here adds
LLM anywhere. This change is about the opt-in LLM features behaving honestly: a timeout that
secretly keeps spending tokens, a truncation the service computes but never discloses, and a
dormant fallback helper containing ids that don't exist are all silent degradation of exactly the class
the honesty contract targets — in the one subsystem that costs the user real money.

## Impact

- Files: `src/core/services/llm-service.ts` (abort wiring, output-ceiling constants path,
  truncation warning, catalog cleanup), `src/constants.ts` (per-provider output ceilings,
  replacing literals); tests for abort-on-timeout, timer cleanup, ceiling resolution,
  truncation warning, and catalog↔pricing-table consistency.
- Specs: `llm` — 3 ADDED requirements (TimeoutCancelsTheUnderlyingRequest,
  OutputTokenCeilingSingleSourced, KnownModelCatalogConsistency).
- Tool surface: unchanged (no new tool, no MCP payload-budget impact — the LLM layer is not
  on the tool hot path).
- Risk: low-medium. Raising several API-provider defaults changes cost ceilings for opt-in
  LLM commands (disclosed; caps remain caller-overridable), while Gemini remains at its
  existing 8,192 cap through a constant; abort wiring only takes effect on the timeout path;
  catalog shrinkage removes ids that never had matching pricing entries.
