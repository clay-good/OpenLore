## 1. Shared opt-out reader

- [x] 1.1 Add `envTlsOptOut(scopeKey)` plus the `EMBED_TLS_ENV` / `LLM_TLS_ENV` constants to
      `src/core/services/tls-scope.ts`, with no global union key; verify by unit test that
      only `1` and `true` are affirmative and that every other value fails closed
- [x] 1.2 Clear both keys in `resetTlsScopeForTests` so env state cannot leak between cases;
      verify the tls-scope suite passes with no cross-test contamination
- [x] 1.3 Assert surface isolation in both directions — the embedding key never relaxes the
      LLM and vice versa; verify the two dedicated tests pass

## 2. LLM surface

- [x] 2.1 Consult the operator env in `resolveTrustedSslVerify` after the flag and before the
      repository value; verify by test that `LLM_SKIP_SSL_VERIFY=1` relaxes with no flag, that
      an explicit flag still wins, and that a repo-supplied opt-out is still refused
- [x] 2.2 Default `createLLMService`'s `sslVerify` from the env so callers that pass nothing
      (the MCP daemon, the embedded API) get the lever; verify the llm-service suite passes
- [x] 2.3 Name the new variable in the refusal messages so a refused repo value points at the
      operator-supplied alternative; verify the repo-config-trust suite passes

## 3. Embedding surface

- [x] 3.1 Route `EmbeddingService.fromEnv` and `fromConfig` through the shared reader, keeping
      the repository's own opt-out refused; verify the embedding-service suite passes
- [x] 3.2 Make the request site inherit a CLI `--insecure` instead of short-circuiting it;
      verify by inspection of the `withRelaxedTls` call and a passing suite
- [x] 3.3 Disclose a half-configured environment (`EMBED_BASE_URL` without `EMBED_MODEL`)
      without framing the keyword index as degraded; verify the two embedder tests pass —
      one asserting the warning, one asserting silence when nothing is configured

## 4. Diagnostics

- [x] 4.1 Honour the operator's embedding opt-out in `openlore doctor`; verify the doctor
      suite passes and the check no longer fails against a self-signed endpoint that
      `analyze` reaches
- [x] 4.2 Mirror `fromEnv` precedence in doctor — environment-only when `EMBED_BASE_URL` is
      set — so the check exercises the settings actually in effect; verify by doctor tests

## 5. Documentation

- [x] 5.1 Add both TLS variables and `NODE_EXTRA_CA_CERTS` to the environment-variable table
      in `docs/configuration.md`; verify the table renders and the anchor resolves
- [x] 5.2 Write the "Self-signed certificates" section covering the preferred CA route, the
      scoped skip keys, and the repo-config refusal; verify the cross-links from
      `docs/providers.md` and `docs/semantic-search.md` point at it
- [x] 5.3 State the both-variables-required rule for remote embeddings in
      `docs/semantic-search.md`; verify it matches the warning the code emits

## 6. Verification

- [x] 6.1 Typecheck the workspace (`tsc --noEmit`) and verify it reports no errors
- [x] 6.2 Run the affected suites (`src/core/services`, the embedding analyzer tests, the
      doctor tests) and verify all pass with no regressions
- [x] 6.3 Run a cross-model review of the working-tree diff and triage its findings, treating
      the TLS trust boundary as the area to scrutinise hardest

## 7. Review findings and scenario coverage

- [x] 7.1 Cover the mirrored half-configured case (`EMBED_MODEL` without `EMBED_BASE_URL`),
      which the first implementation missed; verify by the dedicated embedder test
- [x] 7.2 Route every relaxable request site through a surface helper (`llmTlsRelaxed` /
      `embeddingTlsRelaxed`) so no site opts itself out of the flag or the env key; verify
      the six previously-unreachable sites in `chat-agent.ts` and `view.ts` are covered and
      that `withRelaxedTls` has no argument-less or hard-`false` LLM/embedding call left
- [x] 7.3 Assert surface isolation at the real TLS boundary (self-signed handshake), not
      only on the reader's return value; verify the five tls-scope boundary tests pass
- [x] 7.4 Assert doctor's TLS decision and its env-only precedence; verify the three new
      doctor tests pass
- [x] 7.5 Assert the refusal messages name the operator-supplied alternative; verify by the
      repo-config-trust message test
- [x] 7.6 Add the doc-and-source policy guard for the opt-out surface (two scoped variables,
      no union key, documented CA alternative); verify `src/tls-opt-out-policy.test.ts` passes
- [x] 7.7 Produce the scenario-to-test matrix covering all 11 delta scenarios and verify the
      relevant suites pass (126 files / 2612 tests) and `openspec validate --strict` is clean
