# Enforce preset membership at dispatch: the advertised surface must be the callable surface

> Status: PROPOSED (2026-07-27, first-run e2e). The preset architecture — benchmark-gated default
> (ADR-0023), "tools remain available strictly by opt-in" (mcp-quality), "substrate holds
> governance READS, not writes" (`reconcile-substrate-write-face`, PR #234) — governs only
> `tools/list`. `tools/call` dispatches **any of the ~73 registered tools**, including writes.
> Verified live against a default (`substrate`, 13-tool) server: `find_dead_code` (not in the
> surface) executed and returned results; `record_decision` and `remember` (write face, excluded
> by ADR) executed and **persisted state** to `.openlore/decisions/ledger.jsonl` and memory
> `notes.json`. Only a truly unknown name is rejected. Every preset below `full` is currently a
> presentation choice, not a boundary.

## The gap

- `tools/list` serves the preset-filtered `activeTools` (`src/cli/commands/mcp.ts:2414-2416`);
  the `CallToolRequestSchema` handler resolves the tool from the full definition table and
  validates args against it (`mcp.ts:2478+`), with no membership check against the active preset.
  Empirically: under `--preset substrate`, `tools/call find_dead_code` → full result;
  `tools/call record_decision` → `"Decision recorded … consolidation running in background"`;
  `tools/call remember` → memory persisted. `tools/call totally_fake_tool` → `Unknown tool`.
- This contradicts the written contract three ways:
  1. mcp-quality: tools outside the default "remain available **strictly by opt-in**: a named
     preset, or the explicit full-surface selector" — they are available to any caller today.
  2. `reconcile-substrate-write-face` (shipped) repositioned the default surface as "navigation
     core + governance reads"; the write face (`record_decision`, `remember`,
     `approve_decision`…) is reachable from that surface regardless.
  3. An operator who chose `--preset navigation` (the lean read-only escape) or `--minimal` for
     governance reasons has not actually narrowed what a prompt-injected or misbehaving agent can
     execute — including tools that mutate the repo's governance record.
- The gap is invisible: nothing in the response indicates the tool was outside the advertised
  surface, and no test guards the boundary (contrast `tool-contract.test.ts`, which guards
  family declarations).

## What changes

- **Dispatch checks membership.** `tools/call` for a registered tool that is not in the active
  preset returns a **tool error** (`isError: true` — reaches the model, which can self-correct;
  the SEP-1303 rationale from the open `adopt-mcp-protocol-conformance` sibling) whose text names
  the tool, the active preset, the preset(s) that contain the tool, and the rewire command
  (`openlore install --preset <name>`). Deprecated aliases keep resolving, then the canonical
  name is membership-checked.
- **The boundary is guarded in CI.** A test walks `TOOL_PRESETS` × the dispatch path: for each
  preset, one out-of-surface call must produce the membership error and — for write-family tools —
  must leave no persisted side effect.
- **The mcp-security posture is stated.** Write-capability tools (`change`/`remember` families'
  mutating members) are unreachable through any preset that does not advertise them; this is a
  named requirement, not an emergent property.

Escape hatch considered and rejected: keeping hidden-but-callable as an "expert path" — it makes
every published claim about narrow surfaces false and cannot coexist with presets as governance.
An agent that needs more tools re-wires with a wider preset, exactly as the initialize
instructions already say.

## Impact

- Affected specs: `mcp-quality`, `mcp-security`
- Affected code: `src/cli/commands/mcp.ts` (CallTool handler: membership check before
  validation/dispatch), new guard test beside `mcp-presets.test.ts`; serve-daemon delegation path
  must enforce the same check for forwarded calls
