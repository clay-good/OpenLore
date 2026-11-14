# The MCP server tells clients how long an answer stays fresh, and long builds can be watched

> Priority: P3 · Not built · Waiting on the protocol (see below)
> Reaches the agent through: every existing MCP answer (`orient`, `blast_radius`, `verify_change`, `verify_claim`, `recall`); the wire format only
> Why it helps the agent: the client can read freshness as data, and a first index build shows progress and can be canceled.

## This change waits

Nothing here is built until all three are true:

1. The MCP specification revision that defines cache hints and tasks (2026-07-28) is final.
2. The `@modelcontextprotocol/sdk` version this repository pins supports it.
3. Claude Code supports it.

Until then the only work is to record the state of these three gates in this folder.

## Problem

- The freshness lease reaches the client only as a sentence added to the result text
  (`injectFreshness` in `src/core/services/mcp-handlers/epistemic-lease.ts`). A client cannot read
  it without parsing prose.
- The first index build runs as a background promise with no handle, no progress, and no cancel
  (`bootstrapAnalysisInBackground`, called from `src/cli/commands/mcp.ts`). A full
  `analyze_codebase` call blocks its request for the whole build.
- `find_clones` takes `symbol` or `snippet`, never both, but its schema cannot say so. The rule
  lives in description text and a runtime check.
- The server has a custom `initialize` handler in `src/cli/commands/mcp.ts` that carries the real
  package version, client identity, and the pointer to wider presets. The new revision has no
  handshake.

## What changes

- **Cache hints carry the lease.** `tools/list` gets the required `ttlMs` / `cacheScope`. Results
  of existing tools may carry a hint derived from the lease's existing threshold
  (`DEGRADE_AGE_MS`). A hint is never longer than the lease allows. A result whose validity ends
  on a repository change (a `recall` verdict, a certificate) declares the most conservative scope
  instead of a time. The prose note stays, byte for byte.
- **Long builds are tasks.** When the client negotiates tasks, `analyze_codebase` and the
  first-run index build return a task handle with progress and cancel. No other tool becomes a
  task.
- **Schemas state exclusivity.** `find_clones` declares `symbol` XOR `snippet` with `oneOf`. Other
  prose-only "exactly one of" rules get the same treatment. `validateToolArgs`
  (`src/core/services/mcp-handlers/tool-guard.ts`) stays.
- **Handshake facts move.** The version, client identity, and preset pointer move to the carriers
  the final revision provides. The old handler stays for older protocol versions.
- **`tools/list` order is pinned** by a guard test, because the revision asks for a stable order.

## What does not change

- No new MCP tool, preset, CLI command, or integration. Tool names, fields, and preset membership
  stay as they are.
- No answer changes its content. A client without the new capabilities sees today's behavior,
  byte for byte.
- Local only: stdio and loopback. No sampling, no remote transport, no LLM.
- Hooks stay the main way evidence reaches the agent. Works without any spec framework.

## Limits we disclose

- A hint is advice to the client. A client that ignores it loses nothing; a client that caches
  past a repository change is outside OpenLore's control, which is why event-bound results decline
  a time-based hint.
- Canceling a build leaves the store at its earlier state or a flagged partial state, never a
  silently torn graph.
- The details above follow the published revision text and may shift with the SDK.

## Depends on

The three gates above, and the shipped `adopt-mcp-protocol-conformance` work.
