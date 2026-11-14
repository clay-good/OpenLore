# Tasks: adopt-mcp-tasks-and-cache-hints

## 1. Gate (the only work allowed now)

- [ ] 1.1 Record in `openspec/changes/adopt-mcp-tasks-and-cache-hints/proposal.md` the date each
      gate is met: revision final, pinned `@modelcontextprotocol/sdk` support (`package.json`),
      Claude Code support. Done when all three have a date and a source; until then no task below
      starts.

## 2. Cache hints

- [ ] 2.1 Derive `ttlMs` / `cacheScope` from the lease state beside `getFreshnessSignal` in
      `src/core/services/mcp-handlers/epistemic-lease.ts`, with no new tuning constant. Test:
      `src/core/services/mcp-handlers/epistemic-lease.test.ts`. Done when, for fresh, degraded, and
      stale, the hint is never longer than the lease and the prose note is byte-identical to
      today's.
- [ ] 2.2 Attach the hints to `tools/list` and to tool results in `src/cli/commands/mcp.ts`; give
      `recall` verdicts and certificates the most conservative scope. Test:
      `src/cli/commands/mcp.conformance.integration.test.ts`. Done when `tools/list` carries both
      fields and a `recall` result carries no time-based hint.
- [ ] 2.3 Pin the `tools/list` order with a guard in `src/cli/commands/mcp-presets.test.ts`. Done
      when two listings of each preset are identical in order.

## 3. Tasks for long builds

- [ ] 3.1 Return a task handle from `analyze_codebase` and from the first-run build
      (`src/core/services/cold-start-bootstrap.ts`, wired in `src/cli/commands/mcp.ts`) when the
      client negotiates tasks. Test: `src/core/services/cold-start-bootstrap.test.ts` and
      `src/cli/commands/mcp.test.ts`. Done when progress is readable, cancel stops the build
      without a torn store, and a client without the capability sees today's behavior.

## 4. Schemas

- [ ] 4.1 Declare `find_clones` `symbol` XOR `snippet` with `oneOf` in `src/cli/commands/mcp.ts`,
      and convert the other prose-only exclusivity rules; keep `validateToolArgs`
      (`src/core/services/mcp-handlers/tool-guard.ts`). Test: `src/cli/commands/mcp.test.ts` and
      the payload budget in `src/cli/commands/mcp-presets.test.ts`. Done when both-or-neither is
      rejected with an actionable message, one alone passes, and the budget holds.

## 5. Handshake

- [ ] 5.1 Move the version, client identity, and preset pointer from the custom `initialize`
      handler in `src/cli/commands/mcp.ts` to the final revision's carriers; keep the handler for
      older protocol versions. Test: `src/cli/commands/mcp.conformance.integration.test.ts`. Done
      when an old client and a new client both receive the preset pointer and the real version.

## 6. Parity and docs

- [ ] 6.1 Confirm no tool output shape changed with `src/pi/extension.test.ts` (MCP↔Pi parity
      guard). Done when it passes with no edit to expected tool output.
- [ ] 6.2 Describe the hints, the two task-capable operations, and the fallback in
      `docs/mcp-tools.md`. Done when `src/doc-claim-sync.test.ts` passes.
