# Fix the MCP argument contract: a sensible directory default, actionable missing-arg errors, no silently ignored arguments

> Status: IMPLEMENTED (2026-08-15, archived). Three argument-layer frictions hit an agent in
> its first minutes against the default surface: every tool call fails until the model guesses
> that a required absolute `directory` must be passed; the failure message gives no hint what to
> pass; and a mis-named argument is silently dropped — producing a degraded result presented as
> success.

## The gap

All verified against a default (`substrate`) stdio server started in the project root:

- **`directory` is required with no default and no guidance.** `tools/call orient
  {task: "…"}` → `MCP error -32602: Invalid arguments for "orient": /directory: missing required
  property`. The server was launched with its cwd at the repo root — it knows the directory; the
  error could at least say what to pass, and per the open `adopt-mcp-protocol-conformance`
  sibling it should be a tool error the model can self-correct from, not a protocol error. Every
  first session pays this round-trip (or several) per tool until the model learns the
  convention.
- **An unknown argument is silently ignored — and quietly degrades the result.** `tools/call
  remember {directory, content, anchor: "chargeCard"}` (wrong name; the schema wants a different
  anchor field) succeeds with `"anchored": false … recall will not be able to verify it against
  code"`. The caller's intent — anchor this memory — was dropped without an error or a mention
  that an unrecognized property was discarded. For a write tool this persists a *worse* record
  than the caller asked for.
- The conformance sibling covers error *shape* (SEP-1303 tool-vs-protocol errors) and output
  schemas; it does not cover the directory default or unknown-property handling. This change
  owns the argument contract; the sibling owns the envelope.

## What changes

- **`directory` defaults to the server's root.** When omitted, the server resolves the directory
  to its launch root (the cwd it was started in — for the install-wired `.mcp.json`, always the
  project root), subject to exactly the same `validateDirectory` checks as an explicit value. An
  explicit argument always overrides (multi-repo callers unchanged). The tool schemas mark
  `directory` optional with a description stating the default. When no default can be resolved
  (cwd is not an analyzable root), the error names the expected value and shows a concrete
  example.
- **Unknown top-level properties are rejected, not dropped.** Argument validation fails on
  unrecognized properties with a message naming the property and the nearest valid one
  (did-you-mean over the schema's keys — the config-schema validator already ships this
  mechanic). For write tools this is mandatory; for read tools a rejected-by-default posture
  keeps one rule.
- **Missing-argument errors become self-serve.** A missing required property's error names the
  property, its expected shape, and a concrete example value.

## Impact

- Affected specs: `mcp-quality`
- Affected code: `src/cli/commands/mcp.ts` (default resolution before validation; strict
  validation in `validateToolArgs`), tool schema descriptions in `TOOL_DEFINITIONS`; the
  did-you-mean helper reused from the config-schema validator. Sibling:
  `adopt-mcp-protocol-conformance` (error envelope), named, not duplicated.
