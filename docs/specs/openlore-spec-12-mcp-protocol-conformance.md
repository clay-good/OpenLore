# OpenLore Spec 12 — MCP Protocol Conformance

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.

---

## Progress

> Superseded in part (2026-09-12, change `adopt-mcp-protocol-conformance`): argument-validation
> failures are no longer JSON-RPC -32602 errors. They are `isError: true` tool results that name the
> parameter, the expected shape, and a corrected example call (SEP-1303). The rest of this record is
> historical.

Branch: `openlore-spec-12-mcp-protocol-conformance`. **DONE** — handler behavior in PR #117;
the SDK-`Client` conformance suite (acceptance #13) added in PR #137.

> Status update (2026-06-09): the wire-layer behavior below shipped in PR #117. The one remaining
> gap was acceptance #13 — a suite driving the server through the **real SDK `Client`** (the prior
> e2e test used raw JSON-RPC, not the SDK Client). Added as
> [mcp.conformance.integration.test.ts](../../src/cli/commands/mcp.conformance.integration.test.ts):
> 7 passing checks over a stdio `Client` — handshake + version negotiation, single-sourced
> `serverInfo` (version === `package.json`), `tools`-only capabilities, complete single-page
> ListTools, a CallTool round-trip, `-32602` for invalid args, and the unknown-tool `isError`
> posture. The SDK Client parsing successfully also proves stdout hygiene and a clean `close()`.
> Behavior-neutral: no handler/dispatch/protocol code changed.

> The `Initialize` handler in [mcp.ts](../../src/cli/commands/mcp.ts) now negotiates protocol version
> against the SDK's pinned `SUPPORTED_PROTOCOL_VERSIONS` (echo the client's version when supported,
> else offer `LATEST_PROTOCOL_VERSION` = `2025-11-25`). `capabilities` is honest (`{ tools: {} }`
> only — no `listChanged`, which we do not implement). `serverInfo` carries the real package name +
> version (single source). Argument/validation failures now map to JSON-RPC **-32602** via spec-10's
> input validation throwing `McpError(ErrorCode.InvalidParams)`; tool-execution failures stay
> `isError: true` results.

- [x] Pin the MCP protocol version the installed SDK targets and document it in the spec / PR.
- [x] Conformance audit of the `Initialize` / `ListTools` / `CallTool` handlers against that protocol version.
- [x] Make the advertised `capabilities` object honest (only `tools`, with `listChanged` only if implemented).
- [x] Make `serverInfo` correct and consistent (single source for name + real package version).
- [x] Protocol-version handling in the initialize result follows the spec negotiation rule.
- [x] Map argument/validation failures (spec-10) to JSON-RPC `-32602`; keep tool-execution failures as `isError: true` results.
- [x] Unknown tool name and unknown method return the correct error shape (`-32601` for unknown method).
- [x] Decide and implement `ListTools` pagination posture (cursor support, or single-page with a test that proves it).
- [x] stdout hygiene guard: a test proves only JSON-RPC bytes reach stdout in mcp mode.
- [x] Clean shutdown on stdin EOF / SIGTERM / SIGINT; no unhandled-rejection crash.
- [x] Protocol conformance test suite using the SDK `Client` over an in-memory / piped transport.
- [x] `lint`, `typecheck`, `test:run`, `build` all green; integration suite green.

## Context for you (the agent)

OpenLore ships an MCP server that exposes roughly 45 static-analysis tools (`orient`, `search_code`, `get_subgraph`, `analyze_impact`, `check_spec_drift`, the decisions tools, and the rest) to MCP clients. The primary client is Claude Code, which spawns the server as a subprocess (`node dist/cli/index.js mcp`) and talks JSON-RPC 2.0 over **stdio**. This is the user's own daily-driver MCP server, so it must be a fully spec-compliant citizen of the protocol, behaving exactly the way Anthropic's own reference servers and the SDK examples do.

The server lives in [src/cli/commands/mcp.ts](../../src/cli/commands/mcp.ts), function `startMcpServer`. It uses `@modelcontextprotocol/sdk` (pinned at `^1.27.1` in `package.json`):

- `Server` from `@modelcontextprotocol/sdk/server/index.js`
- `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`
- request schemas `InitializeRequestSchema`, `ListToolsRequestSchema`, `CallToolRequestSchema` from `@modelcontextprotocol/sdk/types.js`

The server already registers handlers for all three methods. Current wiring (verified):

- Construction: `new Server({ name: 'openlore', version: pkgVersion }, { capabilities: { tools: {} } })` at [mcp.ts:1315](../../src/cli/commands/mcp.ts#L1315).
- `ListTools` returns **all** `activeTools` in one response, with no cursor handling ([mcp.ts:1320](../../src/cli/commands/mcp.ts#L1320)). The full set is the exported `TOOL_DEFINITIONS` ([mcp.ts:134](../../src/cli/commands/mcp.ts#L134)).
- `Initialize` echoes `request.params.protocolVersion`, returns `capabilities: { tools: {} }`, and returns `serverInfo: { name: 'openlore', version: _pkgVersion }` ([mcp.ts:1334](../../src/cli/commands/mcp.ts#L1334)). Note the **two different version variables** (`pkgVersion` in the constructor, `_pkgVersion` in the initialize result) — verify they are the same value and collapse to one source.
- `CallTool` dispatches on `name`, wraps the result in a `content: [{ type: 'text', text }]` block, returns unknown tools as `{ content, isError: true }` ([mcp.ts:1554](../../src/cli/commands/mcp.ts#L1554)), and catches handler throws into `{ content: [...], isError: true }` ([mcp.ts:1576](../../src/cli/commands/mcp.ts#L1576)).
- Transport: `new StdioServerTransport()` then `server.connect(transport)` ([mcp.ts:1585](../../src/cli/commands/mcp.ts#L1585)).
- stdout protection already exists: `console.log/info/warn/debug` are reassigned to write to **stderr** ([mcp.ts:1300](../../src/cli/commands/mcp.ts#L1300)). Confirm `src/utils/logger.ts` also never writes to stdout in mcp mode.

### What this spec is, and is not

The SDK already implements the hard parts of the wire protocol: JSON-RPC 2.0 framing, request/response correlation, method routing, and most error mapping. **Do not reimplement any of that.** This spec is about the thin application layer that OpenLore controls and that can still be wrong: the contents of the initialize result (capabilities, serverInfo, protocol-version handling), the mapping of failures to the correct JSON-RPC error codes versus tool-result `isError`, pagination posture for `ListTools`, stdout hygiene, clean shutdown, and a real conformance test suite that locks all of it.

This is one of four sibling specs hardening the MCP server. Stay in your lane:

- **spec-09 (Live-data test harness)** — the test infrastructure those tests run on. Reuse it; do not rebuild it.
- **spec-10 (MCP tool response hardening)** — app-level **argument validation**, per-tool **timeouts**, **output size limits**, and **error message normalization** live there. Spec-12 only decides which JSON-RPC error code or `isError` result those failures map to at the wire layer.
- **spec-11 (MCP tool surface audit)** — tool **names**, **descriptions**, and **annotations** live there. Spec-12 does not rename or re-describe tools.
- **spec-12 (this one)** — the WIRE PROTOCOL layer only.

## Scope contract — do not break these things

This PR must NOT:

- Reimplement JSON-RPC framing, request routing, or transport mechanics the SDK already provides. Use `Server`, `StdioServerTransport`, and the request schemas as designed.
- Change tool names, descriptions, annotations, or argument schemas (spec-11 / spec-10 territory).
- Change the body/JSON shape that any tool returns inside its `text` content. Consumers parse those; leave them alone. You may change how that body is **wrapped** into `content` blocks only if the wrapping stays spec-valid and backward-compatible.
- Add `resources`, `prompts`, `logging`, `completions`, or `sampling` support. Do not advertise capabilities the server does not implement.
- Write anything except JSON-RPC bytes to **stdout** in mcp mode. Any stray `console.log`, banner, progress line, or dependency print to stdout corrupts the stream and breaks every client.
- Block the event loop or leave the process alive after the client disconnects.
- Bump the `@modelcontextprotocol/sdk` version as part of this PR. Conform to the **pinned** version's protocol. If a needed feature only exists in a newer SDK, document it as a follow-up rather than silently upgrading.

This PR must:

- First determine the exact MCP protocol version the installed SDK (`^1.27.1`, read the actual resolved version) targets, document it in the PR body, and audit the three handlers against that version's requirements.
- Advertise an **honest** `capabilities` object: only `tools`, and `tools.listChanged` only if the server actually emits `notifications/tools/list_changed`.
- Return a correct, single-sourced `serverInfo` (name + real package version).
- Handle the initialize protocol-version negotiation per the spec rule (echo the client's version if the server supports it; otherwise return the server's latest supported version).
- Map failures to the right place: argument/validation failures to JSON-RPC `-32602` (invalid params); unknown method to `-32601`; genuine internal faults to `-32603`; tool-execution failures (a tool ran but failed) to a `CallTool` **result** with `isError: true` per MCP convention.
- Take a defensible, spec-correct `ListTools` pagination posture and prove it with a test.
- Guarantee stdout hygiene with an automated test, and shut down cleanly on stdin EOF / SIGTERM / SIGINT without unhandled rejections.
- Lock every one of the above with an in-process protocol conformance test suite that drives the server through the real SDK `Client`.

## The deliverable

### 1. Pin and document the protocol version (do this first)

Before changing any handler, determine which MCP protocol version the **installed** SDK targets. Read it from the SDK itself (for example the `LATEST_PROTOCOL_VERSION` / `SUPPORTED_PROTOCOL_VERSIONS` constants exported from `@modelcontextprotocol/sdk/types.js`, or the resolved version in `node_modules/@modelcontextprotocol/sdk/package.json`). Do not assume a date string from memory. Record the discovered version and supported-version list in the PR body. Every subsequent decision (capabilities shape, pagination, structured content) is justified against **that** version, not against the latest published spec.

### 2. Honest capabilities

Audit the capabilities advertised in both the `Server` constructor ([mcp.ts:1317](../../src/cli/commands/mcp.ts#L1317)) and the initialize result ([mcp.ts:1339](../../src/cli/commands/mcp.ts#L1339)).

- Advertise `tools: {}`. Add `tools: { listChanged: true }` **only if** the server actually sends `notifications/tools/list_changed`. The tool set is static for a session unless `--minimal` toggling or a future dynamic registry changes it; if nothing emits the notification, do **not** claim `listChanged`. State the decision in the PR.
- Do not add `resources`, `prompts`, `logging`, `completions`. Removing a falsely-advertised capability is in scope; adding a real one is not.
- The constructor capabilities and the initialize-result capabilities must be **identical**. Define one capabilities object and reference it in both places so they cannot drift.

### 3. Correct, single-sourced serverInfo

The server currently reads the package version into `pkgVersion` for the constructor and uses a separate `_pkgVersion` in the initialize result. Collapse these to a single source of truth (read once), so `serverInfo.version` is guaranteed to equal the version passed to `new Server(...)`. `serverInfo.name` stays `openlore`. If the SDK version supports an optional `title`/display-name field in `serverInfo`/`Implementation`, set it only if it is part of the pinned protocol; otherwise leave it out.

### 4. Protocol-version negotiation in the initialize result

The current handler blindly echoes `request.params.protocolVersion`. Per the MCP spec, the server must respond with a version it actually supports:

- If the client's requested `protocolVersion` is in the server/SDK's supported set, echo it.
- If it is not supported, respond with the server's latest supported version (let the client decide whether it can proceed).

Prefer to derive the supported set from the SDK constants discovered in step 1 rather than hardcoding strings. If the pinned SDK already performs this negotiation internally (some versions validate the requested version before the handler runs), document that and make the handler's response consistent with what the SDK enforces, rather than fighting it. Add a test that asserts the response version is always one the server supports, for both a matching and a deliberately-bogus requested version.

### 5. Error-handling correctness (wire layer)

This is the crux. MCP draws a sharp line between two failure kinds, and they go to different places:

- **Protocol-level errors** are returned as JSON-RPC error responses with a `code`:
  - `-32700` parse error (malformed JSON) — handled by the SDK; do not touch.
  - `-32600` invalid request (malformed JSON-RPC envelope) — handled by the SDK.
  - `-32601` method not found — an unknown JSON-RPC **method** (not an unknown tool). The SDK returns this for unregistered methods; confirm OpenLore does not accidentally swallow it.
  - `-32602` invalid params — the request reached a handler but the arguments are structurally wrong (missing required field, wrong type, unknown tool name where the spec treats that as invalid params). When spec-10's argument validation rejects a `CallTool` request as malformed, that rejection must surface as `-32602`, raised via the SDK's error type (for example `throw new McpError(ErrorCode.InvalidParams, msg)` from `@modelcontextprotocol/sdk/types.js`) so the SDK serializes a proper JSON-RPC error — **not** as an `isError` result.
  - `-32603` internal error — an unexpected server fault.
- **Tool-execution errors** are returned as a **successful** `CallTool` result whose body carries the failure, with `isError: true` and the message in a `content` text block. This is the MCP convention: "the tool ran and reported failure" is data the model should see, not a transport fault.

Apply this distinction concretely:

- **Unknown tool name** ([mcp.ts:1554](../../src/cli/commands/mcp.ts#L1554)): decide the correct treatment for the pinned protocol. A request to call a tool the server never advertised is arguably invalid params (`-32602`) rather than a tool that "ran and failed." Most reference servers raise a JSON-RPC error here. Pick the spec-correct option, justify it, and apply it consistently. (If you keep `isError: true` for compatibility, document why and have a test pin the chosen behavior either way.)
- **Argument validation failures** (from spec-10): map to `-32602` via `McpError`. Spec-12 only owns the mapping; the validation logic itself is spec-10. Coordinate so spec-10 throws a typed error and spec-12 ensures it serializes correctly. If spec-10 has not landed yet, add the mapping seam (a typed error class the validator can throw) and a test that proves a thrown validation error becomes `-32602`.
- **Genuine tool failures** (a handler threw mid-execution): keep the existing `{ content, isError: true }` path ([mcp.ts:1576](../../src/cli/commands/mcp.ts#L1576)). Confirm the message is sanitized (`sanitizeMcpError`) and that an internal/unexpected fault that is *not* a tool's own reported failure is distinguishable. Where the right answer is "transport-level internal error," raise `McpError(ErrorCode.InternalError, ...)` so it becomes `-32603`.

Document, in code comments and the PR, the rule: "invalid input shape or unknown method/tool -> JSON-RPC error code; a tool that ran and failed -> `isError: true` result."

### 6. Structured tool results

The server returns `content: [{ type: 'text', text }]`, JSON-stringifying object results ([mcp.ts:1563](../../src/cli/commands/mcp.ts#L1563)). This is valid for every protocol version.

- Confirm every `CallTool` return path emits a valid `content` array of `{ type: 'text', text: string }` blocks (the freshness-signal second block at [mcp.ts:1569](../../src/cli/commands/mcp.ts#L1569) is fine; assert it stays a separate block and is never concatenated into the result body).
- **Structured content / `outputSchema`:** newer MCP protocol revisions add a `structuredContent` field on tool results and an `outputSchema` on tool definitions. **Check whether the pinned SDK supports these before assuming.** If the pinned version supports them, this PR may *optionally* add `structuredContent` for tools that already return well-shaped JSON (mirroring the JSON already in the text block, not replacing it) — but only if it stays small and is locked by tests. If the pinned version does **not** support them, do nothing here and leave `TODO(spec-12-followup): adopt structuredContent/outputSchema once the SDK is upgraded`. Do not bump the SDK to get this feature.

### 7. ListTools pagination posture

`ListTools` returns all ~45 tools in one response with no `nextCursor` ([mcp.ts:1320](../../src/cli/commands/mcp.ts#L1320)). The MCP `ListTools` result supports cursor-based pagination (`params.cursor` in, optional `nextCursor` out). Pick **one** spec-correct posture and justify it in the PR:

- **Option A (recommended if the set stays small):** all tools fit in a single page; the handler ignores any inbound `cursor` it does not recognize gracefully and returns no `nextCursor`. This is spec-valid: pagination is optional and a server may return everything in one page. Add a test asserting the response is a valid `ListTools` result, contains every tool in `activeTools`, and omits `nextCursor`. This is the simplest correct choice and the SDK handles the envelope.
- **Option B (future-proof):** implement real cursor-based pagination (stable ordering, opaque cursor encoding a page offset, `nextCursor` when more pages remain, correct handling of an unknown/expired cursor). Choose this only if you also want the tool list to stay paginated as it grows; it is more code and more test surface.

Default to **Option A** and document that the full tool set fits one page, with a test proving the response shape is valid and complete. If you choose B, the conformance suite must walk all pages and assemble the full set.

### 8. stdout hygiene guard

Corrupting stdout is the single most common way to break a stdio MCP server. The server already redirects `console.*` to stderr ([mcp.ts:1300](../../src/cli/commands/mcp.ts#L1300)).

- Verify `src/utils/logger.ts` never writes to stdout when running in mcp mode (no `process.stdout.write`, no bare `console.log` that escapes the redirect). If it can, route it to stderr in mcp mode.
- Add an automated guard: a test that runs the server (in-process or as a child process driven by the SDK `Client`), performs a full handshake plus a `CallTool` round-trip, captures everything written to the real stdout fd, and asserts that **every** byte on stdout parses as JSON-RPC (newline-delimited messages, each a valid JSON-RPC object). Any non-JSON line fails the test. This is the regression that protects every client.

### 9. Clean shutdown and no unhandled rejections

- The process must exit cleanly when the client disconnects: on **stdin EOF** (the transport's close), and on **SIGTERM** / **SIGINT**. Today SIGINT/SIGTERM handlers are only installed on the watcher paths ([mcp.ts:1359](../../src/cli/commands/mcp.ts#L1359), [mcp.ts:1598](../../src/cli/commands/mcp.ts#L1598)); ensure the base (non-watch) server also shuts down cleanly on signal and on transport close, flushing nothing to stdout.
- Add an `unhandledRejection` / `uncaughtException` posture: log to stderr and exit non-zero rather than crashing mid-message or hanging. Do not let a rejected promise in one tool call take down the whole server silently.
- Add a test (process-level) asserting the server exits within a short timeout after stdin is closed.

### 10. Protocol conformance test suite

Add a dedicated conformance suite that drives the server through the **real SDK client** over an in-process transport, so it tests the actual wire behavior, not the handlers in isolation.

- Use `Client` from `@modelcontextprotocol/sdk/client/index.js`. If the pinned SDK ships an in-memory transport pair (commonly `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/sdk/inMemory.js`), connect the client and a server instance to the two ends. If that helper is not in the pinned version, drive the existing `StdioServerTransport` server as a child process over its stdio pipes and connect a `StdioClientTransport` to it. Pick whichever the pinned SDK supports; document the choice.
- The suite must assert:
  - **initialize handshake** succeeds; the negotiated `protocolVersion` is a supported one; `serverInfo` name/version are correct and the version matches `package.json`; advertised `capabilities` contains exactly `tools` (and `listChanged` iff implemented) and nothing else.
  - **listTools** returns a valid result containing every tool in `activeTools` (and the chosen pagination posture holds).
  - **callTool round-trip** for a known no-op-ish tool (one that does not require a built analysis cache, or seeded via the spec-09 harness) returns a valid `content` array of text blocks.
  - **error cases**: a `CallTool` with a deliberately invalid argument shape surfaces as `-32602`; an unknown tool name surfaces with the chosen-and-documented behavior; a tool whose handler throws returns `isError: true` (not a JSON-RPC error). Reuse the spec-09 live-data harness for any tool that needs a real analysis cache; do not hand-roll fixtures spec-09 already provides.
- Co-locate as a vitest file (for example `src/cli/commands/mcp.conformance.test.ts`, or `.integration.test.ts` if it needs the live cache so it runs under `vitest.integration.config.ts` / `npm run test:e2e`). Keep pure-protocol assertions (handshake, capabilities, error codes) in the always-on unit suite so they run in CI.

## Files you will create or modify (approximate)

```
src/cli/commands/mcp.ts                       # capabilities single-source, serverInfo single-source,
                                              #   protocol-version negotiation, error-code mapping
                                              #   (McpError for -32602/-32601/-32603), unknown-tool
                                              #   posture, ListTools pagination posture, base-server
                                              #   shutdown + unhandledRejection handling
src/utils/logger.ts                           # confirm/route: never write to stdout in mcp mode
src/cli/commands/mcp.conformance.test.ts      # NEW: in-process SDK Client handshake/listTools/
                                              #   callTool/error-code assertions (always-on)
src/cli/commands/mcp.stdout-hygiene.test.ts   # NEW: only JSON-RPC bytes on stdout; clean shutdown
                                              #   (may fold into the conformance file)
docs/specs/openlore-spec-12-mcp-protocol-conformance.md  # this file: tick the Progress boxes
README.md / docs/…                            # only if a doc claims a protocol behavior that changes
```

Touch only what the change requires. Do not refactor the `CallTool` dispatch switch, do not rename tools, do not alter tool argument schemas. This is the wire layer.

## Acceptance criteria

1. The PR body states the exact MCP protocol version the installed `@modelcontextprotocol/sdk` targets (read from the SDK, not assumed) and the supported-version set, and justifies each protocol decision against it.
2. The advertised `capabilities` object is identical in the `Server` constructor and the initialize result, contains only `tools`, and includes `tools.listChanged` **only if** the server actually emits the corresponding notification. No `resources`/`prompts`/`logging`/`completions` are advertised.
3. `serverInfo` is single-sourced: `serverInfo.version === package.json version === the version passed to new Server(...)`. A test asserts the equality.
4. Initialize protocol-version negotiation returns a version the server supports for both a matching requested version and a bogus requested version. A test covers both.
5. An invalid-argument `CallTool` surfaces as JSON-RPC `-32602` (via `McpError`/`ErrorCode.InvalidParams`), not as an `isError` result. A test asserts the error `code`.
6. An unknown tool name produces the chosen, documented, spec-correct behavior (JSON-RPC error preferred; `isError` only if justified), pinned by a test either way.
7. An unknown JSON-RPC **method** results in `-32601` (method not found) and is not swallowed. A test asserts it.
8. A handler that throws mid-execution returns a `CallTool` result with `isError: true` and a sanitized message — never a JSON-RPC error. A test asserts it.
9. Every `CallTool` return path emits a valid `content` array of `{ type: 'text', text: string }` blocks; the freshness-signal block remains a separate, never-concatenated block. If `structuredContent`/`outputSchema` were added, they are valid for the pinned protocol and locked by a test; if not, a scoped `TODO(spec-12-followup)` is left.
10. `ListTools` returns a valid result containing every tool in `activeTools` under the chosen pagination posture (single-page with no `nextCursor`, or full multi-page walk). A test asserts shape and completeness.
11. stdout hygiene: a test runs a full handshake + `CallTool` round-trip and asserts that every byte written to stdout in mcp mode is valid newline-delimited JSON-RPC. `src/utils/logger.ts` is confirmed/fixed to never write to stdout in mcp mode.
12. Clean shutdown: the base (non-watch) server exits cleanly on stdin EOF and on SIGTERM/SIGINT; an `unhandledRejection`/`uncaughtException` logs to stderr and exits non-zero rather than hanging or printing to stdout. A test asserts the server exits within a short timeout after stdin closes.
13. The conformance suite drives the server through the real SDK `Client` over an in-process (or child-process stdio) transport and covers handshake, capabilities, listTools, a callTool round-trip, and the error cases above. Pure-protocol assertions run in the always-on CI suite.
14. No SDK version bump. No tool renames, re-descriptions, annotation changes, or argument-schema changes (those are spec-10 / spec-11).
15. `npm run lint`, `npm run typecheck`, `npm run test:run`, and `npm run build` all pass; the integration suite (`npm run test:e2e`) passes.

## Git workflow — read carefully

1. Branch `openlore-spec-12-mcp-protocol-conformance` off the default branch.
2. Open **exactly one** PR titled `spec-12: MCP protocol conformance`. All follow-up commits push to the same PR. Never open a second PR.
3. The PR body must include: the discovered SDK protocol version + supported set; the capabilities/serverInfo/version-negotiation decisions; the chosen unknown-tool and pagination postures with justification; and confirmation that the stdout-hygiene and shutdown tests pass.
4. `startMcpServer` is the highest-fan-out entry point in the codebase. Make additive, surgical changes; do not refactor the dispatch switch or the tool definitions. Record the architectural decisions (capabilities posture, error-code mapping rule, pagination posture) per the repo's decision-gate workflow before writing code.
5. Run `npm run lint`, `npm run typecheck`, `npm run test:run`, and `npm run build` before every push, plus `npm run test:e2e` for the conformance/integration tests.

## When you are done

Reply with: PR URL, summary, follow-ups, files changed. Nothing else.
