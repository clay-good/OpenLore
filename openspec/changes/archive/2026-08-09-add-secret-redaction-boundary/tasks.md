# Tasks — add-secret-redaction-boundary

## Implementation
- [x] Shared module `src/core/services/secret-redaction.ts`: deterministic pattern set (provider
      API-key shapes, private-key blocks, bearer/JWT, connection strings, cloud credential
      formats), returning redacted text + span count + kinds; dependency-light (importable
      by MCP handlers, llm-service, and the Pi surface without pulling the analyzer)
- [x] Tool-output boundary: apply the pass at the shared dispatch/transport seam for
      source-carrying tools (get_function_body, find_clones snippets, analyze_env_impact
      read sites, search_code excerpts); replace spans with typed markers; add the
      disclosed `redactions` field (never silent)
- [x] Config opt-out (config-manager.ts): a `.openlore/config.json` key disabling the
      tool-output pass for trusted-solo use; default on
- [x] LLM logs: replace the two coarse prompt-only regexes in `redactSecrets`
      (llm-service.ts:1800-1815) with the shared module; redact `response.content` before
      `logRequest` stores it (llm-service.ts:1786-1795); record the redaction count in the
      log entry written by saveLogs (llm-service.ts:1851-1868)
- [x] Pi parity: confirm the Pi extension's native tools receive redacted output through the
      same dispatch seam; note in the PR if any Pi path bypasses it

## Verification
- [x] Pattern tests: each pattern has positive fixtures (real-shaped fake secrets) and
      negative fixtures (identifiers, hashes, UUIDs) — precision individually pinned
- [x] Boundary test: a fixture repo function containing a fake API key returns via
      get_function_body with the span redacted AND `redactions: 1` disclosed
- [x] Opt-out test: with the config key set, content is verbatim and no redaction field
      claims otherwise
- [x] Log test: a prompt AND a response containing fake secrets are both scrubbed in the
      written llm-log JSON, with the count recorded
- [x] Payload budget: measure the disclosure field against the mcp-presets.test.ts ceiling;
      adjust the ceiling only with the measured delta stated
- [x] Full suite green

## Spec
- [x] `mcp-security` delta: ADD RepoSecretRedactionAtTheToolOutputBoundary,
      LlmLogRedactionCoversPromptsAndResponses
