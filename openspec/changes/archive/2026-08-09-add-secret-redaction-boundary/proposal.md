# One redaction boundary: repo secrets never reach the model or the log undisclosed

> Status: PROPOSED (2026-07-03, e2e audit pass 3). MCP tools that carry raw source
> (function bodies, clone snippets, env read sites, search excerpts) return file content
> verbatim, and the LLM request log persists full prompts AND responses to disk with only
> two coarse regexes over the prompt side. Add ONE shared, deterministic secret-redaction
> module applied at both boundaries — tool output and LLM logs — with every redaction
> DISCLOSED ("N spans redacted"), never a silent rewrite. Prior art: the Octocode MCP
> server scans and redacts every byte before it reaches the model (300+ patterns, local
> engine).

## The gap

- **(a) Tool outputs ship raw source.** `get_function_body`, `find_clones` snippets,
  `analyze_env_impact` read sites, and `search_code` excerpts return repository content
  verbatim through the shared dispatch (`tool-dispatch.ts`; transports in `mcp.ts` /
  `serve.ts` handle truncation but nothing scans content). A hardcoded credential in the
  analyzed repo — exactly what `analyze_env_impact` is likely to sit next to — flows
  straight into the agent's context and from there into transcripts, memory files, and
  whatever the host logs.
- **(b) LLM logs persist prompts and responses nearly verbatim.** Every real LLM command
  sets `enableLogging: true` (`decisions.ts:596`, `drift.ts:428`, `generate.ts:478`,
  `run.ts:511`) and `saveLogs()` (`llm-service.ts:1851-1868`) writes
  `.openlore/logs/llm-log-*.json` (default `logDir`, `:1536`) containing full source
  prompts and git diffs. `redactSecrets` (`llm-service.ts:1800-1815`) scrubs only the
  PROMPT with two coarse regexes, and `logRequest` (`:1786-1795`) stores
  `response.content` verbatim — a secret the model echoes back is persisted unredacted.
  Severity is bounded honestly: `.openlore/` is gitignored (`.gitignore:19`), so this is
  disk exposure on the local machine, not a commit leak — but "the log directory happens
  to be gitignored" is not a redaction contract.

## What changes

1. **One shared redaction module** (dependency-light, e.g. `src/utils/secret-redaction.ts`):
   a deterministic pattern set (provider API-key shapes, private-key blocks, bearer/JWT,
   connection strings, cloud credential formats) with per-pattern tests. No entropy
   scoring, no learned model — fixed patterns only, so verdicts are reproducible. Both
   surfaces import it; the two coarse regexes in `llm-service.ts` are replaced, not
   triplicated. (MCP handlers + llm-service today; the Pi extension's native tools reach
   tool output through the same dispatch — parity question answered structurally.)
2. **Tool-output boundary pass** at the shared dispatch/transport seam for tools that carry
   raw source: matched spans are replaced with a typed marker and the result gains a
   disclosed `redactions: N spans (kinds)` field per the honesty contract — never a silent
   rewrite, so an agent knows the body it sees is not byte-exact. Opt-out via
   `.openlore/config.json` for trusted-solo use (disclosed default-on).
3. **LLM log redaction on BOTH sides**: `redactSecrets` moves to the shared module and is
   applied to prompts AND `response.content` before `logRequest` stores them; the log entry
   records the redaction count so a scrubbed log is distinguishable from a clean one.

## Why this is in scope

The substrate's job is to feed agents repository content; a deterministic redaction pass at
the output boundary is the mcp-security spec's *Secret Confinement* discipline extended from
the tool's own credentials to the analyzed repo's — the same local-first, no-LLM,
disclosed-boundary shape as the rest of the hardening arc, with working prior art in Octocode
(https://github.com/bgauryy/octocode: "every byte that reaches the model is scanned and
redacted first").

## Impact

- Files: new `src/utils/secret-redaction.ts` (patterns + tests);
  `src/core/services/llm-service.ts` (`redactSecrets` delegated, responses covered,
  redaction count in log entries); the dispatch/transport output seam
  (`tool-dispatch.ts` / `mcp.ts` / `serve.ts`) for the source-carrying tools;
  `config-manager.ts` (opt-out key).
- Specs: `mcp-security` — 2 ADDED requirements (RepoSecretRedactionAtTheToolOutputBoundary,
  LlmLogRedactionCoversPromptsAndResponses).
- Tool surface: no new tool. The disclosure field adds a small constant per affected tool
  result — measure against the payload-budget ceiling in `mcp-presets.test.ts` and adjust
  if needed (the field is bounded, not content-proportional).
- Risk: low-medium. False positives redact non-secret strings (mitigated by typed markers +
  disclosure + config opt-out; patterns are precision-tuned and individually tested);
  redaction is deterministic so cached/verbatim consumers see stable output. Honest bound:
  log exposure was disk-local (gitignored), not a commit leak — this closes a
  defense-in-depth gap, not an active exfiltration.
