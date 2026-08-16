# Tasks — harden the viewer chat agent

## Implementation
- [x] Per-provider model resolution in `resolveProviderConfig` (chat-agent.ts:134-159):
      `cfgModel` applies only when the resolved branch matches the provider the config
      named; `OPENAI_COMPAT_MODEL` (:119) applies only to the openai-compat branch; each
      branch otherwise uses its own DEFAULT_<provider>_MODEL; request `modelOverride`
      stays authoritative
- [x] Fail fast on missing key: a resolved provider with an empty apiKey returns an
      actionable "no API key configured for chat" error before any fetch (kills the
      `?key=` empty-key Gemini URL, :378)
- [x] Honest terminal states at all three loop exits (:344-348, :431-436, :522-531):
      abort → "stopped: aborted"; MAX_ITERATIONS → "stopped: iteration budget exhausted"
      + surviving partial assistant text; delete the fabricated 'Analysis complete. Check
      highlighted nodes.' string
- [x] Per-attempt timeout in `fetchWithRetry` (:196-215): AbortController timeout composed
      with the caller signal per attempt; timeout value from an existing constant, cleared
      on settle (the harden-llm-request-lifecycle discipline at this site — that change's
      files untouched)
- [x] Injection-boundary wiring for tool-result content entering prompts (:340, :425,
      :516) via the shared harden-llm-prompt-injection-boundary mechanism (extends; no
      modification to that change)

## Verification
- [x] Provider-matrix tests: default config (generation.model = claude-sonnet-4-6) +
      GEMINI_API_KEY only → Gemini branch uses DEFAULT_GEMINI_MODEL, never the Anthropic
      default; OPENAI_COMPAT_MODEL set → Gemini/Anthropic branches unaffected;
      cfgProvider='anthropic' + generation.model set → Anthropic uses it
- [x] Missing-key test: cfgProvider='gemini' with no GEMINI_API_KEY → upfront error naming
      the env var; no network call issued
- [x] Terminal-state tests: aborted signal mid-loop → reply states aborted, never
      "Analysis complete"; MAX_ITERATIONS exhausted with partial text → reply discloses
      exhaustion and carries the partial text
- [x] Timeout test: a never-resolving fetch (mock) is aborted at the per-attempt timeout
      and retried per the existing 429/5xx policy; success path leaves no dangling timer
- [x] Full suite green

## Spec
- [x] `llm` delta: ADD ChatProviderModelResolutionIsPerProvider,
      ChatAgentTerminalStatesAreHonest
- [x] `mcp-security` delta: ADD ChatToolResultsCrossTheInjectionBoundary
