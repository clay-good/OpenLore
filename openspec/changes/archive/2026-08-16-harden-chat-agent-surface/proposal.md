# Harden the viewer chat agent: per-provider model resolution and honest terminal states

> Status: BUILT (2026-08-16). The viewer chat agent
> (`src/core/services/chat-agent.ts`) was never audited by any prior pass. Its provider
> resolution leaks a config/env model across providers — a default-config repo with only a
> Gemini key sends `claude-sonnet-4-6` to the Gemini API and 404s on every message — and an
> aborted or budget-exhausted agent loop replies with the invented string "Analysis
> complete. Check highlighted nodes." Extends `harden-llm-request-lifecycle` and
> `harden-llm-prompt-injection-boundary` (both generate-pipeline scoped) to the chat
> surface they never touched.

## The defect(s)

- **(a) Config/env model leaks across providers.** Every branch of
  `resolveProviderConfig` (`chat-agent.ts:134-159`) resolves the model as
  `envModel || cfgModel || DEFAULT_<provider>_MODEL` (`:139`, `:148`, `:158`), where
  `envModel` is `OPENAI_COMPAT_MODEL` (`:119`) and `cfgModel` is `generation.model`
  (`:129`). But `getDefaultConfig` (`config-manager.ts:64-65`) stamps
  `generation.model: DEFAULT_ANTHROPIC_MODEL` (`'claude-sonnet-4-6'`, `constants.ts:254`)
  into EVERY init'd config. So a repo with a default config and only `GEMINI_API_KEY` set
  calls `…/models/claude-sonnet-4-6:generateContent` (`:378`) — a guaranteed 404 on every
  chat message. Symmetrically, `OPENAI_COMPAT_MODEL=gpt-4o` silently overrides the model
  for the Gemini AND Anthropic branches. And `cfgProvider === 'gemini'` with no
  `GEMINI_API_KEY` builds the URL with `?key=` (empty, `:378`) instead of an upfront
  honest "no API key configured for chat".
- **(b) Fabricated success conclusion; no per-attempt timeout.** When a loop exits via the
  `signal.aborted` break or by exhausting `MAX_ITERATIONS`, all three provider loops reply
  with the invented string `'Analysis complete. Check highlighted nodes.'` — OpenAI-compat
  `:344-348`, Gemini `:431-436`, Anthropic `:522-531`. An aborted or truncated agentic run
  is presented to the user as a completed analysis — a conclusion-honesty violation in a
  product whose contract is "never fabricate a conclusion". Separately, `fetchWithRetry`
  (`:196-215`) retries 429/5xx but has NO per-attempt timeout — the `fetch` at `:209`
  carries only the caller's abort signal, so a hung provider hangs the viewer chat forever.
- **(c) Un-scoped boundary note.** Chat tool results (repo-derived data: file contents,
  search snippets) flow verbatim into subsequent provider prompts (`:340`, `:425`, `:516`).
  That is exactly the surface `harden-llm-prompt-injection-boundary` disciplines for the
  generate pipeline; the chat loop must carry the same source-tagging/boundary treatment.
  This change scopes it in; the mechanism is that change's, applied here (extends — its
  files are not modified by this proposal).

## What changes

1. **Per-provider model resolution.** `generation.model` and `OPENAI_COMPAT_MODEL` apply
   only when the RESOLVED provider matches how they were configured: `cfgModel` counts only
   when `cfgProvider` (or, absent a config provider, the key-derived provider) matches the
   branch; `OPENAI_COMPAT_MODEL` applies only to the `openai-compat` branch. Each branch
   otherwise falls to its own `DEFAULT_<provider>_MODEL`. A `modelOverride` from the
   request stays authoritative (existing behavior).
2. **Fail fast on a missing key.** A resolved provider with an empty API key returns an
   upfront, actionable error ("no API key configured for chat — set GEMINI_API_KEY …")
   instead of sending `?key=`/empty-header requests to the provider.
3. **Honest terminal states.** The abort break replies "stopped: aborted"; the
   iteration-budget exit replies "stopped: iteration budget exhausted — partial results
   below" prefixed to whatever real assistant text exists (the existing last-text recovery
   stays; only the fabricated completion string dies). No terminal path invents success.
4. **Per-attempt timeout.** `fetchWithRetry` wraps each attempt in an `AbortController`
   timeout composed with the caller's signal — the `harden-llm-request-lifecycle`
   abort-wiring discipline applied at the chat fetch site (that change's files untouched).
5. **Injection-boundary parity.** Tool-result content entering chat prompts is scoped into
   `harden-llm-prompt-injection-boundary`'s treatment (source-tagged, boundary-delimited)
   via the shared mechanism once it lands; this change adds the chat-site wiring.

## Why this is in scope

The chat agent is the one interactive LLM surface the viewer ships; doctrine keeps LLMs off
the computation path (decision `c6d1ad07`) but demands the opt-in LLM features behave
honestly. A provider mismatch that 404s out of the box is a broken first-run; a fabricated
"Analysis complete" is the precise conclusion-dishonesty class the honesty contract exists
to kill; a hang with no timeout is the request-lifecycle defect already fixed elsewhere —
the discipline exists, unapplied at this surface.

## Impact

- Files: `src/core/services/chat-agent.ts` (provider/model resolution, missing-key fail
  fast, terminal-state strings, per-attempt timeout, injection-boundary wiring). No change
  to `config-manager.ts` defaults (the default config stays; the chat agent stops
  misapplying it).
- Specs: `llm` — 2 ADDED requirements (ChatProviderModelResolutionIsPerProvider,
  ChatAgentTerminalStatesAreHonest); `mcp-security` — 1 ADDED requirement
  (ChatToolResultsCrossTheInjectionBoundary).
- Tool surface: unchanged (no MCP tool involved; viewer-internal).
- Risk: low. Model resolution changes only mismatched-provider cases (which 404 today);
  terminal-state strings are user-visible copy; the timeout only fires on hung requests.
