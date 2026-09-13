# OpenLore Spec 10 — MCP Tool Response Hardening

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.

---

## Progress

> Superseded in part (2026-09-12, change `adopt-mcp-protocol-conformance`): argument-validation
> failures are no longer JSON-RPC -32602 errors. They are `isError: true` tool results that name the
> parameter, the expected shape, and a corrected example call (SEP-1303). The rest of this record is
> historical.

Branch: `openlore-spec-10-mcp-tool-response-hardening`. **DONE** (in PR #117).

> Implemented as [tool-guard.ts](../../src/core/services/mcp-handlers/tool-guard.ts), applied in the
> `CallToolRequestSchema` handler in [mcp.ts](../../src/cli/commands/mcp.ts) so every one of the 49
> tools runs the same path: **input validation** before dispatch against each tool's own
> `inputSchema` (reusing spec-05's `validateAgainstSchema`, no Ajv; invalid args → JSON-RPC -32602);
> **per-tool timeout** via `Promise.race` (`MCP_TOOL_TIMEOUT_MS` + slow-tool overrides);
> **output cap** (`MCP_TOOL_MAX_BYTES`, deterministic truncation + how-to-narrow note, never a silent
> drop); **error normalization** to a stable taxonomy (`INVALID_ARGS`/`NOT_ANALYZED`/`TIMEOUT`/
> `INTERNAL`), distinguishing "not analyzed yet" from real failures; and **structured telemetry**
> (`tool`/`ms`/`bytes`/`outcome`/`code`) via the existing `emit`. Tested in
> [tool-guard.test.ts](../../src/core/services/mcp-handlers/tool-guard.test.ts).

> Status: **implemented** (commit `387a3f1`). Verified 2026-06-09: `tool-guard.ts`
> (`validateToolArgs` / `withToolTimeout` / `capOutput` / `classifyToolError`) is applied
> uniformly in `mcp.ts`; the error-code taxonomy, telemetry, `constants.ts` defaults, and
> `tool-guard.test.ts` are all present.

- [x] `src/core/services/mcp-handlers/tool-guard.ts` — a single `withToolGuards` wrapper applied in the `CallToolRequestSchema` handler in `mcp.ts`, so every one of the ~45 tools runs through the same input-validation, timeout, output-cap, error-normalization, and telemetry path
- [x] Input validation BEFORE the handler runs: validate `args` against the called tool's own `inputSchema` (the JSON Schema already declared on each entry of `TOOL_DEFINITIONS`), reusing the hand-written JSON-Schema-subset validator pattern from spec-05 (`schemas/` + `schema-validator.ts`) — do NOT add Ajv
- [x] Per-tool TIMEOUT via the `Promise.race` pattern already used in `readCachedContext`, with a sensible default in `src/constants.ts` and a per-tool override table
- [x] Output size cap: when a result exceeds the byte budget, truncate deterministically, set `truncated: true`, and attach a note telling the agent how to narrow the query — never silently drop data
- [x] Error normalization: route every thrown error through the existing `sanitizeMcpError`, mapped to a stable error-code taxonomy (`INVALID_ARGS`, `NOT_ANALYZED`, `TIMEOUT`, `OUTPUT_TRUNCATED`, `INTERNAL`), distinguishing "repo not analyzed yet" (actionable) from real failures
- [x] Structured per-call telemetry (`tool`, `duration_ms`, `bytes`, `outcome`) via the existing `emit`
- [x] Centralize directory validation + `safeJoin` so individual handlers stop re-implementing them
- [x] Defaults defined in `src/constants.ts` (timeout ms, output byte budget)
- [x] Co-located tests for the wrapper (`tool-guard.test.ts`) plus an existing-tests-still-green check; live-repo verification leans on spec-09's harness
- [x] `lint`, `typecheck`, `test:run`, `build` all green

---

## Context for you (the agent)

OpenLore is a static-analysis engine exposed as an MCP server, used primarily from inside Claude Code. It is the maintainer's own server, and this is one of four sibling specs hardening that server to match how Anthropic and Claude Code build MCP servers:

- **spec-09 — Live-data test harness.** Validates tools against real repos. You will use spec-09's harness to VERIFY the changes in this spec; do not build it here.
- **spec-10 — MCP tool response hardening (THIS SPEC).** Make every tool's RESPONSE robust and consistent: uniform input validation, timeouts, output-size limits, error normalization, telemetry.
- **spec-11 — MCP tool surface audit/consolidation.** Naming, descriptions, annotations, deprecation. NOT your job.
- **spec-12 — MCP protocol conformance.** Initialize handshake, capabilities, JSON-RPC error codes. NOT your job.

The MCP server entry point is `startMcpServer` in `src/cli/commands/mcp.ts`. The `CallToolRequestSchema` handler (around `mcp.ts:1344`) dispatches by tool name through a long `if/else` chain to handlers in `src/core/services/mcp-handlers/{graph,semantic,orient,change,decisions,analysis}.ts`. There are ~45 tools in the exported `TOOL_DEFINITIONS` array (`mcp.ts:134`); each entry has a `name`, a `description`, and a JSON-Schema `inputSchema`.

The important thing to understand before you write a line: **the guards this spec wants already partly exist, but are applied inconsistently, per-handler.** `src/core/services/mcp-handlers/utils.ts` already exports:

- `validateDirectory(directory, maxDepth?)` — resolves and checks the directory exists, with a path-traversal guard.
- `safeJoin(absDir, filePath)` — blocks path traversal outside the project root.
- `sanitizeMcpError(err, format)` — strips API keys, Bearer tokens, and Authorization headers from error messages; can return `{ message, code }` when `format === 'json'`.
- `readCachedContext(directory, timeout?)` — already supports a timeout via `Promise.race`, and caches the ~3.7MB `llm-context.json` by mtime.
- `computeProjectFingerprint` / `isCacheFresh` for cache validity.

So directory validation, path-traversal guards, and error sanitization exist — but each handler decides for itself whether to call them, what error shape to return, whether to bound its output, and whether to apply a timeout. There is no single choke point. A handler that forgets `validateDirectory`, or returns a raw `throw`, or emits a 5MB result, breaks the uniformity an MCP client depends on. A long-running handler can even stall the stdio request loop because nothing bounds its duration.

The opportunity is exactly one shared wrapper around dispatch so every tool gets the same treatment. The happy path must not change: existing successful outputs stay byte-identical except when output truncation actually triggers. You are adding guards around the dispatch, not rewriting the handlers.

Two things already in the dispatch path that you must NOT break:

- The epistemic-lease tracker (`src/core/services/mcp-handlers/epistemic-lease.ts`: `createTracker`, `updateTracker`, `getFreshnessSignal`). It is updated before dispatch (`mcp.ts:1372-1377`). Keep that ordering: tracker update happens, then the guarded handler runs.
- Existing per-handler `emit(...)` telemetry calls (`src/core/services/telemetry.ts`). Your wrapper-level telemetry is ADDITIVE structured per-call data, not a replacement for handler-specific events like the `orient_call` event.

## Scope contract — do not break these things

This PR must NOT:

- Rename, add, remove, merge, or redescribe any tool. Naming, descriptions, and annotations are spec-11. The `name`/`description` of every `TOOL_DEFINITIONS` entry stays exactly as-is.
- Touch the MCP protocol handshake, capability negotiation, or JSON-RPC framing. That is spec-12.
- Change any successful tool output, EXCEPT when output truncation actually fires on an oversized result.
- Add Ajv or any new schema-validation dependency. Reuse the hand-written JSON-Schema-subset validator pattern spec-05 established.
- Add any other new runtime dependency.
- Change the analyzer, the graph schema, or how `llm-context.json` is produced.
- Break the epistemic-lease tracker ordering or existing per-handler `emit` calls.
- Make a single tool special-cased in `mcp.ts` so that it bypasses the wrapper. Every tool goes through the same path.

This PR must:

- Introduce ONE shared dispatch wrapper that every tool flows through.
- Be behavior-preserving on the happy path: every currently-passing test still passes unchanged.
- Validate `args` against the called tool's declared `inputSchema` before the handler runs, and reject with a structured error naming the offending field.
- Bound every tool by a timeout so no tool can hang the stdio loop.
- Cap output size deterministically and signal truncation rather than dropping data silently.
- Normalize every error into one MCP error-result shape with a stable error-code taxonomy.
- Emit structured per-call telemetry for every tool.
- Centralize directory validation + `safeJoin` so handlers stop re-implementing them.

## The deliverable

### The wrapper: `withToolGuards`

Create `src/core/services/mcp-handlers/tool-guard.ts` exporting a single wrapper that the `CallToolRequestSchema` handler applies uniformly. Conceptual shape (adapt to the existing dispatch, do not over-engineer):

```ts
export interface ToolGuardOptions {
  timeoutMs?: number;       // per-tool override; falls back to MCP_TOOL_DEFAULT_TIMEOUT_MS
  maxBytes?: number;        // per-tool override; falls back to MCP_TOOL_MAX_OUTPUT_BYTES
}

export async function withToolGuards(
  toolName: string,
  args: Record<string, unknown>,
  inputSchema: unknown,            // the called tool's inputSchema from TOOL_DEFINITIONS
  run: () => Promise<unknown>,     // the existing handler invocation
  opts?: ToolGuardOptions,
): Promise<ToolResult>;            // the normalized MCP content/error result shape
```

`withToolGuards` performs, in order:

1. **Validate args against `inputSchema`.** Use the JSON-Schema-subset validator (the spec-05 `schema-validator.ts` pattern). Validate `type`, `required`, `properties` types, and `enum`/`minimum`/`maximum` where the subset already supports them. On failure, return an `INVALID_ARGS` error result whose message names the offending field (for example: `invalid argument "limit": expected number, got string`). Do not call the handler.
2. **Run the handler under a timeout.** Wrap `run()` in the same `Promise.race([run(), timeoutPromise])` pattern `readCachedContext` already uses. On timeout, return a `TIMEOUT` error result naming the tool and the elapsed budget. The default budget comes from `MCP_TOOL_DEFAULT_TIMEOUT_MS`; a per-tool override table (see below) handles the genuinely slow tools like `analyze_codebase`.
3. **Cap output size.** Serialize the successful result and measure its byte length. If it exceeds `MCP_TOOL_MAX_OUTPUT_BYTES`, truncate deterministically (see below) and attach `truncated: true` plus a `truncation_note`. This is the ONLY case where a successful output changes shape.
4. **Normalize errors.** Any error thrown by `run()` (or by validation/timeout) is passed through `sanitizeMcpError(err, 'json')` and mapped to the error-code taxonomy. Detect the "repo not analyzed yet" case (the error/cache state that means `llm-context.json` is missing) and return `NOT_ANALYZED` with an actionable message: `run "openlore analyze" in this directory first`. Everything else is `INTERNAL`.
5. **Emit telemetry.** On every call (success, truncation, or error), call `emit(directory, 'mcp_tool', { tool, duration_ms, bytes, outcome })` where `outcome` is one of `ok | truncated | invalid_args | not_analyzed | timeout | error`. Reuse `_t0` already captured at `mcp.ts:1366` so duration is measured around the whole guarded call.

### Error-code taxonomy

Define these as a small const map (in `tool-guard.ts` or `src/constants.ts`) and use them everywhere:

| Code | When | Message guidance |
|---|---|---|
| `INVALID_ARGS` | args fail `inputSchema` validation | Name the offending field and the expected vs. actual type. |
| `NOT_ANALYZED` | repo has no analysis artifact yet | Actionable: tell the agent to run `openlore analyze`. |
| `TIMEOUT` | handler exceeded its timeout budget | Name the tool and the budget in ms; suggest narrowing the query. |
| `OUTPUT_TRUNCATED` | result exceeded the byte budget | Carried on the result as `truncated: true` + `truncation_note`, not as a failure. |
| `INTERNAL` | any other thrown error | Sanitized message via `sanitizeMcpError`; no secrets. |

`OUTPUT_TRUNCATED` is informational on an otherwise-successful result; the other four are terminal error results. Keep the codes stable strings — spec-12 may later map them to JSON-RPC numeric codes, so do not invent ad-hoc variants.

### Deterministic truncation

Truncation must be reproducible for the same input so tests and the spec-09 harness can assert on it:

- If the result is an array (or its top-level payload is a list of items), drop items from the END until the serialized size fits, and record how many were dropped in `truncation_note`.
- If the result is a single large blob (for example a function body), truncate the string at a byte boundary and append a clear marker.
- Always set `truncated: true` and a human-readable `truncation_note` such as: `output truncated to 256KB (showing 120 of 540 results); narrow with a more specific query or a smaller "limit"`.
- Never reorder or sample; truncation is a deterministic tail-drop so repeated calls produce identical truncated output.

### Centralized directory validation + `safeJoin`

Today individual handlers call `validateDirectory` and `safeJoin` ad hoc. Centralize this so the wrapper (or a thin helper it calls) resolves and validates `args.directory` once, before dispatch, for every tool that declares `directory` in its `inputSchema`. Tools that take a `filePath` get a single `safeJoin` against the validated directory at the choke point. Handlers may keep calling `validateDirectory` defensively — it is idempotent — but the canonical guard now lives at the wrapper. Do NOT delete `validateDirectory`/`safeJoin`; route through them.

### Constants

Add to `src/constants.ts` (match the existing `_MS` / `_BYTES` naming convention already used there, for example `LLM_CLI_TIMEOUT_MS`, `MAX_CHAT_BODY_BYTES`):

```ts
export const MCP_TOOL_DEFAULT_TIMEOUT_MS = 30_000;   // per-tool default; override the slow ones
export const MCP_TOOL_MAX_OUTPUT_BYTES   = 256 * 1024; // deterministic truncation threshold
```

Pick the actual numbers against real behavior with the spec-09 harness: the default timeout must comfortably clear the p99 of normal tool calls, and the byte budget must sit below what would blow the client context while still returning useful payloads. `analyze_codebase` and any other genuinely long tool get a per-tool timeout override (a small table keyed by tool name in `tool-guard.ts`), not a raised global default.

### Verification leans on spec-09

Functional verification of "every tool is guarded the same way" belongs to spec-09's live-data harness. In this PR, add focused unit tests for the wrapper itself (below) and confirm the existing suite stays green. If spec-09 has landed, wire a harness assertion that drives every tool through the server and checks each result conforms to the normalized shape (either valid content or a taxonomy error code) and that none exceed the byte budget. If spec-09 has NOT landed yet, leave a `TODO(spec-10-followup): assert every tool conforms via spec-09 harness` and rely on the unit tests.

## Files you will create or modify (approximate)

```
src/core/services/mcp-handlers/
  tool-guard.ts            # withToolGuards + error-code taxonomy + truncation + per-tool overrides
  tool-guard.test.ts       # co-located unit tests for the wrapper
  utils.ts                 # (only if a small helper export is needed; reuse, do not rewrite)
src/cli/commands/mcp.ts    # route the CallToolRequestSchema dispatch through withToolGuards
src/constants.ts           # MCP_TOOL_DEFAULT_TIMEOUT_MS, MCP_TOOL_MAX_OUTPUT_BYTES
schemas/                   # reuse the spec-05 JSON-Schema-subset validator pattern; no new dep
docs/                      # short note on the response contract + error taxonomy (optional, if a docs/mcp page exists)
```

Keep the diff in `mcp.ts` as mechanical as possible: the existing `if (name === 'x') { ... result = await handleX(...) }` branches should be wrapped so each `result = await handleX(...)` runs inside `withToolGuards(name, args, inputSchema, () => handleX(...))`, rather than rewriting each branch's body. Prefer one wrapping point over editing 45 branches by hand if the structure allows it.

## Acceptance criteria

1. A single `withToolGuards` wrapper exists in `src/core/services/mcp-handlers/tool-guard.ts` and EVERY tool dispatched by the `CallToolRequestSchema` handler in `mcp.ts` flows through it. No tool bypasses it.
2. Calling any tool with args that violate its `inputSchema` returns an `INVALID_ARGS` error result naming the offending field, and the underlying handler is never invoked (assert with a spy/mock in a unit test).
3. A handler that hangs is bounded: a tool whose `run()` never resolves returns a `TIMEOUT` error result within its budget, and the stdio loop remains responsive (unit test with a deliberately-slow fake handler and a tiny override).
4. A result larger than `MCP_TOOL_MAX_OUTPUT_BYTES` comes back with `truncated: true`, a `truncation_note`, and a serialized size at or below the budget. Calling twice produces byte-identical truncated output (deterministic tail-drop).
5. Every error returned to the client is sanitized (no API keys, Bearer tokens, or Authorization values leak — assert by throwing an error containing a fake key and checking it is stripped) and carries exactly one taxonomy code.
6. The "repo not analyzed yet" condition returns `NOT_ANALYZED` with a message that tells the agent to run `openlore analyze`, distinct from `INTERNAL`.
7. Each tool call emits one structured `emit(directory, 'mcp_tool', { tool, duration_ms, bytes, outcome })` telemetry record with `outcome` from the defined set; existing per-handler telemetry (for example the `orient_call` event) is preserved.
8. Directory validation and `safeJoin` are applied at the wrapper choke point; no successful happy-path output changes as a result.
9. The epistemic-lease tracker still updates before dispatch and its behavior is unchanged.
10. No new runtime dependency is added; Ajv is not introduced. The schema validation reuses the spec-05 JSON-Schema-subset validator pattern.
11. `MCP_TOOL_DEFAULT_TIMEOUT_MS` and `MCP_TOOL_MAX_OUTPUT_BYTES` are defined in `src/constants.ts`, and slow tools (for example `analyze_codebase`) have per-tool timeout overrides rather than a raised global default.
12. The entire existing test suite passes unchanged (happy path is behavior-preserving). `npm run lint`, `npm run typecheck`, `npm run test:run`, and `npm run build` all pass.

## Git workflow — read carefully

1. Branch: `openlore-spec-10-mcp-tool-response-hardening` off the default branch.
2. Implement the response-hardening wrapper ONLY. Do not rename or redescribe tools (spec-11). Do not touch the protocol handshake or capabilities (spec-12). Do not build the live-data harness (spec-09).
3. **Open exactly one PR** titled `spec-10: MCP tool response hardening`.
4. All follow-up commits for this spec push to the same PR. Never open a second PR. If the wrapper needs revision, push it to the existing branch.
5. If verifying "every tool conforms" is impossible because spec-09 has not landed, leave a `TODO(spec-10-followup): assert every tool conforms via spec-09 harness` and rely on the unit tests. Do not build the harness here.
6. Run `lint`, `typecheck`, `test:run`, `build` before every push.

## When you are done

Reply with: PR URL, summary, follow-ups, files changed. Nothing else.
