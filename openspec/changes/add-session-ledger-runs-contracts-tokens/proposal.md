# Session ledger, part 2: test runs, contract hashes, and lease tokens

> Status: PROPOSED (2026-10-31). Split from `add-session-structural-ledger`, whose ledger, named
> background changes, and edit-oscillation signal shipped first. Each part below depends on a
> change that has not shipped yet, so it lands with or after that change. No new tool.

## Why

The session ledger records what the agent was served and what it edited. Three more facts read the
same record but need inputs that do not exist yet:

| Fact | Needs |
|------|-------|
| Symbols edited after the last test run, and the tests that reach them, at stop | the after-tools and before-stop hooks of `add-agent-loop-hook-surfaces` |
| A served API operation or IaC resource changed under the agent | contract and resource nodes from `add-service-contract-certification` and `add-iac-code-binding` |
| A portable `leaseToken` a sub-agent can check with `verify_claim` | the `lease-current` claim kind of `add-graph-claim-kinds` |

Plus raw per-session counts (body-only, signature-changed, exports, contract elements, IaC
resources) in `openlore status --json`, with no percentage or threshold.

## What changes

The three requirements below, unchanged from the original proposal of
`add-session-structural-ledger` (see its archive for the full rationale). The test-run hook records
into the same agent-edit log directory the after-edit hook already writes.

## Impact

- Specs: `mcp-handlers` — 3 ADDED.
- Tool surface: none added.
