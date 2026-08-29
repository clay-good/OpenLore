## LLM Providers

> This page is the canonical LLM **provider** reference. For the full `.openlore/config.json` schema
> (including where these provider values go), see [configuration.md](configuration.md). An LLM is
> optional — `analyze`/`orient`/the graph tools need no API key.

openlore supports eleven provider IDs. The default is Anthropic Claude.

| Provider | `provider` value | API key env var | Default model |
|----------|-----------------|-----------------|---------------|
| Anthropic Claude | `anthropic` *(default)* | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| OpenAI-compatible *(Mistral, Groq, Ollama...)* | `openai-compat` | `OPENAI_COMPAT_API_KEY` | `mistral-large-latest` |
| GitHub Copilot *(via copilot-api proxy)* | `copilot` | *(none)* | `gpt-4o` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-2.0-flash` |
| Gemini CLI | `gemini-cli` | *(none)* | *(CLI default)* |
| Antigravity CLI | `antigravity-cli` | *(none)* | *(CLI default)* |
| Claude Code | `claude-code` | *(none)* | *(CLI default)* |
| Codex CLI | `codex-cli` | *(none)* | *(CLI default)* |
| Mistral Vibe | `mistral-vibe` | *(none)* | *(CLI default)* |
| Cursor Agent CLI | `cursor-agent` | *(none)* | *(CLI default)* |

### Selecting a provider

Set `provider` (and optionally `model`) in the `generation` block of `.openlore/config.json`:

```json
{
  "generation": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "domains": "auto"
  }
}
```

Override the model for a single run:
```bash
openlore generate --model claude-opus-4-20250514
```

### OpenAI-compatible servers (Ollama, Mistral, Groq, LM Studio, vLLM...)

Use `provider: "openai-compat"` with a base URL and API key:

**Environment variables:**
```bash
export OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1   # Ollama, LM Studio, local servers
export OPENAI_COMPAT_API_KEY=ollama                       # any non-empty value for local servers
                                                          # use your real API key for cloud providers (Mistral, Groq...)
```

**Config file** (per-project, loopback endpoints only):
```json
{
  "generation": {
    "provider": "openai-compat",
    "model": "llama3.2",
    "openaiCompatBaseUrl": "http://localhost:11434/v1",
    "domains": "auto"
  }
}
```

**Self-signed certificates** (internal servers, VPN endpoints):
```bash
openlore generate --insecure
```
Select a remote endpoint outside the repository, then opt out of TLS verification explicitly:
```bash
export OPENAI_COMPAT_BASE_URL=https://internal-llm.corp.net/v1
openlore generate --insecure
```

Repository configuration cannot select a remote credential destination or disable TLS. This prevents
a cloned repository from redirecting your API key and source without operator consent.

For remote gateways, keep only non-sensitive generation behavior in `config.json`:
```json
{
  "generation": {
    "provider": "openai-compat",
    "domains": "auto"
  }
}
```

**Proxies that don't support `response_format`** (vLLM, custom gateways):

Some endpoints reject requests that include `response_format` with an error like
`{"detail":"There was an error parsing the body"}`. Set `disableResponseFormat: true`
to omit that field — the model still produces JSON via the system prompt:

```json
{
  "generation": {
    "provider": "openai-compat",
    "disableResponseFormat": true,
    "domains": "auto"
  }
}
```

Set `OPENAI_COMPAT_BASE_URL=https://your-gateway.corp.net/v1` in the operator environment.

Works with: Ollama, LM Studio, Mistral AI, Groq, Together AI, LiteLLM, vLLM,
text-generation-inference, LocalAI, Azure OpenAI, and any `/v1/chat/completions` server.

### GitHub Copilot (via copilot-api proxy)

Use `provider: "copilot"` to generate specs using your GitHub Copilot subscription via the
[copilot-api](https://github.com/ericc-ch/copilot-api) proxy, which exposes an OpenAI-compatible
endpoint from your Copilot credentials.

**Setup:**
1. Install and start the copilot-api proxy:
   ```bash
   npx copilot-api
   ```
   By default it listens on `http://localhost:4141`.

2. Configure openlore:
   ```json
   {
     "generation": {
       "provider": "copilot",
       "model": "gpt-4o",
       "domains": "auto"
     }
   }
   ```

**Environment variables** (optional):
```bash
export COPILOT_API_BASE_URL=http://localhost:4141/v1   # default
export COPILOT_API_KEY=copilot                         # default, only needed if proxy requires auth
```

No API key is required — the copilot-api proxy handles authentication via your GitHub Copilot session.

### CLI-based providers (no API key)

Six provider IDs route LLM calls through local CLI tools instead of HTTP APIs. No API key or configuration is needed — just have the CLI installed and on your PATH. The hardened agent integrations cover four families: Codex, Claude Code, Google Gemini (Gemini CLI or Antigravity CLI), and Cursor.

| Provider | CLI binary | Install |
|----------|-----------|----------------|
| `codex-cli` | `codex` | [Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli) (ChatGPT subscription / CLI auth) |
| `claude-code` | `claude` | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (requires Claude Max/Pro subscription) |
| `gemini-cli` | `gemini` | [Gemini CLI](https://github.com/google-gemini/gemini-cli) (free tier with Google account) |
| `antigravity-cli` | `agy` | [Antigravity CLI](https://antigravity.google/docs/cli-overview) (Google account / subscription) |
| `mistral-vibe` | `vibe` | [Mistral Vibe](https://github.com/mistralai/mistral-vibe) (standalone binary) |
| `cursor-agent` | `cursor-agent` | [Cursor CLI](https://cursor.com/docs/cli/overview) (Cursor subscription / CLI auth) |

```json
{
  "generation": {
    "provider": "claude-code",
    "domains": "auto"
  }
}
```

OpenLore treats these as analysis-only subprocesses. It invokes Codex ephemerally with
user configuration and rules ignored in its read-only sandbox, Claude Code with an empty
tool set and no MCP servers, Gemini CLI with default approval and no pre-approved tools or
extensions, Antigravity CLI in sandbox mode, and Cursor Agent in read-only Ask mode. Each
subprocess runs from an isolated temporary directory so repository instructions, hooks,
plugins, and project settings are not loaded while normal CLI authentication remains
available. A provider invocation fails instead of falling back to unrestricted tool access.
Repository content is passed inside a randomized data boundary and is never trusted as an
instruction. Some harnesses retain read-only or search tools in their restricted modes;
OpenLore prevents repository mutation and project-local configuration loading, but does not
claim that every provider is tool-free. Use the provider's account and network controls when
repository content must not be sent through provider-managed search services.

### Custom base URL for Anthropic or OpenAI

To redirect the built-in Anthropic or OpenAI provider to a proxy or self-hosted endpoint:

```bash
# CLI (one-off)
openlore generate --api-base https://my-proxy.corp.net/v1

# Environment variable
export ANTHROPIC_API_BASE=https://my-proxy.corp.net/v1
export OPENAI_API_BASE=https://my-proxy.corp.net/v1
```

Or in `config.json` under the `llm` block:
```json
{
  "llm": {
    "apiBase": "https://my-proxy.corp.net/v1",
    "sslVerify": false
  }
}
```

`sslVerify: false` disables TLS certificate validation -- use only for internal servers with self-signed certificates.

Priority: CLI flags > environment variables > config file > provider defaults.

## Embedding providers

The providers above are for **LLM** spec generation. Semantic search uses a separate, optional **embedding** provider — and it is never required: keyword (BM25) search is the first-class default.

| Provider | How to enable | API key | Notes |
|----------|---------------|---------|-------|
| Keyword (BM25) | *(default — nothing to do)* | none | First-class default; zero config, no network |
| Local (on-device) | `openlore embed --local` | none | CPU-only; caches `Xenova/all-MiniLM-L6-v2` (~23 MB) under `~/.openlore/models`; needs the optional `@huggingface/transformers` package |
| Remote (OpenAI-compatible) | `EMBED_BASE_URL`/`EMBED_MODEL` or an `embedding` block, then `openlore analyze` | optional (`EMBED_API_KEY`) | Any `/embeddings` endpoint: Ollama, OpenAI, Mistral, vLLM, LM Studio… |

Revert to keyword with `openlore embed --off`. See [docs/semantic-search.md](semantic-search.md#retrieval-modes) for the full reference.

Behind a self-signed certificate — for either the LLM or the embedding endpoint — see [Self-signed certificates](configuration.md#self-signed-certificates). Prefer `NODE_EXTRA_CA_CERTS` over the per-surface skip flags.
