# Session ledger

While an agent works, other processes change code under it: another agent, a teammate, a
background job. And an agent on a long task can loop, changing a function and changing it back.
The session ledger tells the agent both facts, in plain words, without blocking anything.

| Fact | Where it shows | Example |
|------|----------------|---------|
| A symbol the agent read changed under it | a note on the next tool response; `openlore status` | `Served earlier: parseConfig (src/config.ts) — its body changed since you read it at 14:02.` |
| A symbol returned to an earlier version for the second time | the same note; `openlore status`; the panic layer (`edit_oscillation`) | `parseConfig (src/config.ts) returned to an earlier version twice this session.` |

Serving costs a file read, not a parse: the text the agent was shown is kept in memory (up to
16 MB, never written to disk) and hashed only when the file changes. Each fact is stated once. At most three changed symbols are named, the rest counted. A reformat or
comment edit is not a change: versions are normalized content hashes (whitespace and comments do
not change them). The ledger stores addresses and hashes only, never file contents.

## What is recorded

- **Served:** the symbols `orient`, `get_function_skeleton` (the whole file), `get_subgraph`, and the
  top five `search_code` hits return, and the spec files `orient` names, each with its version when
  served.
- **Edited:** each version a symbol takes. When the MCP server runs the file watcher, every
  re-index batch is recorded. When a shared `openlore serve` daemon runs it instead, versions are
  sampled at each tool call (`editSource: "sampled"`).

A session is one MCP server process. Its ledger is
`.openlore/session-ledger/<pid>.json`, removed when the server exits.

## The agent's own edits

A change the agent made is not a background change. OpenLore learns of the agent's edits from the
harness's after-edit hook, which appends each edited file's path and time to
`.openlore/session-ledger/agent-edits.jsonl`. For Claude Code, `openlore install` in the repository
wires one (the [`after-tools` moment](install.md#agent-loop-hooks)); the opt-in
`openlore setup --check-edit-hook claude` records edits too.

Until an after-edit hook reports an edit in a session, background-change notes are withheld,
because an edit cannot be told apart from another process's. `openlore status` says so. Edit loops
do not depend on the hook.

## Test runs

The `after-tools` hook also records the session's test runs (see
[agent-loop hooks](install.md#agent-loop-hooks)) in
`.openlore/session-ledger/test-runs/<session>.json`: the files edited, each run's time, command,
and exit status, and the symbol hashes at the last run. The `before-stop` receipt names what was
edited after that run.

## Lease tokens

`orient` and `recall` return a `leaseToken` (`lt_` and 20 hex characters) naming the functions and
files they served, with a hash of their exact text at that moment, stored in
`.openlore/session-ledger/tokens/` for 12 hours. Issuing reads the files and the cached index only
(no parsing). Any process on the clone can pass it to `verify_claim` with kind `lease-current`:
confirmed when everything has the same text, refuted naming each changed or removed entry, and
unverifiable when a file cannot be read. An edit to an unserved function, or an edit above a served
one, does not change the lease; a reformatted Markdown, YAML, or JSON file does not either.
Whitespace inside a served function does. A served name the index cannot locate (a class) is
listed as not covered; call paths and insertion points are not part of a lease.

## Reading it from another process

`openlore status --json` has a `session` block: `counts` (served, edited, untracked, dropped),
`changeKinds` (how the session's changed symbols changed, first version against latest: `bodyOnly`,
`signatureChanged`, and `unclassified` are disjoint; `exportsChanged` counts the changed exported
ones — counts only, no percentage or threshold), `backgroundChanges[]`, `editOscillation[]` (with each symbol's recent hash cycle), `editSource`, and
`withheld` when a fact is withheld. When the panic layer is on (`panicResponse.mode` `advisory` or
`experimental_blocking`), the `panic-check` hook adds `sessionLedger` with the same two lists to its
JSON output when they are not empty.

These read the ledger of the one live MCP server for the worktree. With none, or with several, the
facts are withheld and the reason is given: OpenLore never picks a session.

## Limits

- When versions are sampled at tool calls, an agent edit any time since the previous version makes
  the new version the agent's own. Two
  agents editing the same worktree, each with an after-edit hook, cannot be told apart: one agent's
  edit counts as the other's own, so it is withheld, never misreported. Give each agent its own
  worktree.
- A watcher batch of more than 20 files (a branch switch, a stash, a formatter run) is not an edit:
  it records no versions, its files are counted as `untracked`, and `bulkBatches` counts it.
- A symbol that was never served starts at the first version observed after an edit, so its loop is
  reported one return later than a served symbol's.
- A served file whose kept text is dropped at the 16 MB bound is counted in `dropped` and
  `untracked`; a change to it is not named until it is served again.
- The agent's own edit is matched to the watcher's version when the hook's report lies up to 30
  seconds before it (or 5 seconds after); a later version by another process is still named.

- A file OpenLore cannot hash (an unsupported language, over 1 MB) is counted as `untracked`, never
  treated as unchanged.
- The ledger keeps 2,000 entries per list; older ones are dropped and counted in `dropped`.
- An oscillation is two returns to an earlier version (A → B → A → B). One return (A → B → A) is
  not reported. There is no score and no threshold beyond that count; only the existing opt-in
  `experimental_blocking` panic mode can turn the signal into a block.
