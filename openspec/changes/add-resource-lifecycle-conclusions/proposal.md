# A changed function that leaves a handle open is reported with the path

> Priority: P3 · Not built
> Reaches the agent through: `verify_change` (advisory finding, also shown at before stop) and the after-edit hook moment (`after-tools`)
> Why it helps the agent: it learns at once that its new early return or throw skips a `close()`, with the exact line.

## Problem

An agent adds an early return or a call that can throw between `open()` and `close()`. The handle,
connection, transaction, or lock now stays open on that path. No test fails and no existing check
sees it. OpenLore already builds a control-flow graph per function (`buildFunctionCfg` in
`src/core/analyzer/cfg.ts`) and already knows which exceptions escape
(`src/core/services/mcp-handlers/error-propagation.ts`), but nothing joins them to ask what was
still held.

## What changes

- **Fact.** For each resource acquired inside a function the diff changed, walk the CFG from the
  acquisition to every exit. A path with no release is `unreleased-on-path`, with the branch or
  throw line and the exit it reaches.
- **Closed pairing table.** Acquire and release names per language (`open`/`close`,
  `connect`/`end`, `acquire`/`release`, `begin`/`commit`|`rollback`, and equivalents). Scope forms
  count as a release on every path: Python `with`, Go `defer`, TypeScript `using` / `await using`,
  and `try/finally`.
- **Finding code.** `resource-unreleased-on-path`, registered in `FINDING_CODE_REGISTRY`
  (`src/core/services/mcp-handlers/enforcement-policy.ts`), severity `warning`, advisory.
- **Only what the change introduced.** A leak path that also exists at the base commit is not
  reported.
- **Where it surfaces.** `verify_change` adds it to its `findings` and receipt. The `after-tools`
  moment in `src/cli/commands/hook.ts` reports it for the file just edited, beside the phantom
  reference and check-weakening items.
- **Exception paths.** When the open path is an exception path, the finding names the exception
  type from the error-propagation evaluator, when that evaluator can name it.

## What does not change

- No new MCP tool, CLI command, or preset. `analyze_resource_lifecycle` is dropped.
- No existing name or field is renamed. The finding is advisory; it blocks only if a repository's
  `enforcement.policy` names the code.
- Local only, no LLM, no runtime leak detection. Works without any spec framework.
- Code that releases correctly stays silent.

## Limits we disclose

- TypeScript, JavaScript, Python, and Go only. Other languages are counted as not assessed.
- A proven open path is reported. Silence is not a claim that a resource is released.
- A resource that is returned, stored outside the function, or passed to an unresolved call is
  not assessed (ownership may have moved). No alias analysis.
- A pairing outside the closed table is not assessed. The table is not user-configurable.
- The result is a lower bound.

## Depends on

Shipped code only: the CFG overlay, the error-propagation handler, `verify_change`, and the hook
runner. Nothing else.
