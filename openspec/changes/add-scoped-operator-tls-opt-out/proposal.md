## Why

An internal endpoint with a self-signed certificate could not be reached from the paths that
never see a command line. The two network surfaces had *inverted* operator levers: embeddings
had an environment-only opt-out (`EMBED_SKIP_SSL_VERIFY`, undocumented anywhere), while the
LLM path had a flag-only one (`--insecure`). So the `openlore mcp` daemon and the decisions
gate spawned by the git pre-commit hook — neither of which parses a command line — had **no**
operator lever at all for LLM TLS, and no documented one for embeddings.

The same gap made `openlore doctor` actively misleading: it ignored `EMBED_SKIP_SSL_VERIFY`
and reported a certificate failure against an endpoint that `openlore analyze` talks to
perfectly well.

## What Changes

- Add `LLM_SKIP_SSL_VERIFY` (LLM provider requests only), the missing counterpart to the
  existing `EMBED_SKIP_SSL_VERIFY` (embedding requests only). Both are read through one
  shared `envTlsOptOut(scopeKey)` helper in `tls-scope.ts`.
- **Deliberately no global union key.** Relaxing verification for one surface must not relax
  the other: an internal self-signed embedding server is not a reason to stop verifying an
  LLM vendor's perfectly valid certificate. The case a global key would serve — every
  outbound endpoint behind one internal CA — is served correctly by `NODE_EXTRA_CA_CERTS`,
  which makes certificates *verify* instead of skipping the check.
- The operator's environment ranks **with** the CLI flag, not with the repository config, in
  `resolveTrustedSslVerify`; `createLLMService` consults it for callers that pass no
  `sslVerify` at all (the daemon, the embedded API).
- An `EmbeddingService` with no opt-out of its own now inherits a CLI `--insecure`, which it
  previously short-circuited.
- `openlore doctor` honours the operator's embedding opt-out, and stops mixing config values
  with environment ones: when `EMBED_BASE_URL` is set the real path is environment-only, so
  reporting on config values described a setup nobody runs.
- `EMBED_BASE_URL` set without `EMBED_MODEL` now warns instead of silently degrading to the
  keyword (BM25) index.
- Document all of it: the TLS variables, `NODE_EXTRA_CA_CERTS` as the preferred fix, and the
  both-variables-required rule. None of this was written down.

Not breaking: `EMBED_SKIP_SSL_VERIFY` keeps its exact meaning and spelling.

## Capabilities

### New Capabilities

- `operator-tls-trust`: Which principal may relax TLS certificate verification, and over
  which surface. Establishes that the opt-out is always operator-supplied and always
  surface-scoped, with no union switch, and that the repository being analyzed can never
  waive verification on the machine analyzing it.

### Modified Capabilities

- `config`: The environment-variable contract gains `LLM_SKIP_SSL_VERIFY`, and states that a
  remote embedding endpoint requires **both** `EMBED_BASE_URL` and `EMBED_MODEL` — a
  half-configured environment is disclosed rather than silently downgraded.

## Impact

- `src/core/services/tls-scope.ts` — shared `envTlsOptOut(scopeKey)`, `EMBED_TLS_ENV`,
  `LLM_TLS_ENV`; no global key.
- `src/core/services/repo-config-trust.ts` — `resolveTrustedSslVerify` consults the operator
  env after the flag, before the (still refused) repo config.
- `src/core/services/llm-service.ts` — `createLLMService` default `sslVerify` reads the env.
- `src/core/analyzer/embedding-service.ts` — factories use the shared reader; the request site
  inherits `--insecure`.
- `src/core/analyzer/embedder.ts` — discloses a half-configured environment.
- `src/cli/commands/doctor.ts` — honours the opt-out; mirrors `fromEnv` precedence.
- `docs/configuration.md` (new "Self-signed certificates" section), `docs/providers.md`,
  `docs/semantic-search.md`.
- Unchanged on purpose: the repo-config trust boundary. `llm.sslVerify: false` and
  `embedding.skipSslVerify: true` stay refused. This change strengthens, and does not
  contradict, the existing `api` requirement `ApiGenerateDoesNotMutateProcessTls`.
