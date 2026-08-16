# llm spec delta

## ADDED Requirements

### Requirement: ChatProviderModelResolutionIsPerProvider

The chat agent SHALL resolve the model per provider: a configured `generation.model` or a
provider-specific model environment variable SHALL apply only when the resolved provider
matches the provider that value was configured for; otherwise the branch SHALL fall back to
its own provider default. The chat agent SHALL NOT send one provider's model identifier to
a different provider's API. A resolved provider whose API key is absent or empty SHALL fail
fast with an actionable error naming the missing credential, before any network request is
issued.

#### Scenario: A default config with only a Gemini key chats successfully

- **GIVEN** a default config (whose `generation.model` is the Anthropic default) and only
  `GEMINI_API_KEY` set
- **WHEN** the chat agent resolves its provider
- **THEN** the Gemini branch uses the Gemini default model, and the Anthropic model id is
  never sent to the Gemini API

#### Scenario: An OpenAI-compat model env var does not leak

- **GIVEN** `OPENAI_COMPAT_MODEL=gpt-4o` and an Anthropic provider resolution
- **WHEN** the chat request is built
- **THEN** the Anthropic branch's model is unaffected by the OpenAI-compat variable

#### Scenario: A missing key fails fast and honestly

- **GIVEN** the config names provider `gemini` and no `GEMINI_API_KEY` is set
- **WHEN** a chat message is sent
- **THEN** the user receives an upfront error naming the missing key, and no request with
  an empty credential is sent to the provider

### Requirement: ChatAgentTerminalStatesAreHonest

The chat agent loop SHALL report its terminal state truthfully: an exit caused by an abort
signal SHALL state that the run was aborted, and an exit caused by exhausting the iteration
budget SHALL state that the budget was exhausted and that any returned text is partial. The
agent SHALL NOT reply with a fabricated completion message on a non-completed run. Each
provider request attempt SHALL carry a timeout that aborts the underlying request, composed
with the caller's abort signal, so a hung provider cannot hang the chat indefinitely.

#### Scenario: An aborted run says so

- **GIVEN** a chat run canceled via its abort signal mid-loop
- **WHEN** the agent returns
- **THEN** the reply states the run was stopped by cancellation and does not claim the
  analysis completed

#### Scenario: Budget exhaustion discloses partial results

- **GIVEN** a run that reaches the iteration budget with intermediate assistant text
- **WHEN** the agent returns
- **THEN** the reply discloses the exhausted budget and presents the surviving text as
  partial

#### Scenario: A hung provider is timed out

- **GIVEN** a provider endpoint that never responds
- **WHEN** a chat request attempt exceeds the per-attempt timeout
- **THEN** the request is aborted and handled by the existing retry policy, and the chat
  surface never hangs indefinitely
