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

### Declarations, not only code

A **declared OpenAPI operation** and an **infrastructure resource** are tracked alongside code
symbols, with the same ids (`openapi.yaml::POST /v1/checkout`, `main.tf::aws_s3_bucket.logs`), so a
teammate's change is named by the element rather than by the file it lives in.

An element model is always narrower than its file, so a declaration file is hashed **both ways**:
one entry per element, and one whole-file entry beside them. The element names the change when it
can; the whole-file entry is the backstop, and it means the worst case is a change named by its
file — never silence.

| Entry | Hash covers | Sees | Does not see |
|---|---|---|---|
| An OpenAPI/Swagger operation | its parsed model: method, path, `operationId`, deprecation, parameters, request body and success response, each with the reader's Merkle hash of the schema it references (even through a local `$ref`) | a changed parameter, required property, schema type, or success-response shape | `security`, non-2xx responses, anything behind an external `$ref`, a path added or removed |
| An infrastructure resource, **Terraform** and **Bicep** | the normalized text of its declared span | any property value in the block | — |
| An infrastructure resource, every other ecosystem (Kubernetes, Helm, CloudFormation, Ansible, Docker, Compose, GitHub Actions) | the parsed IaC model: address, type, kind, module, declaration header, deploy binding, references — those extractors do not close a resource's span | a changed image, dependency, or header | a property value inside the block (a replica count, a port, a step's command) |
| The whole file | its whitespace-normalized text | every edit the rows above miss, including an element deleted or renamed, and a specification that stops parsing | a change in a file the specification only `$ref`s |

What each row does not see is covered by the row below it, and the file-level row is reported only
when no element in that file already named the change — one edit is one fact. Unlike the
code-symbol hash, a resource's span hash is text-level: a comment added inside the block reads as a
change.

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
listed as not covered; call paths and insertion points are not part of a lease. A lease covers
functions and files: a declared operation the `contracts` briefing named is tracked by the ledger
but is not part of a lease, so `lease-current` says nothing about it either way.

## Reading it from another process

`openlore status --json` has a `session` block: `counts` (served, edited, untracked, dropped),
`changeKinds` (how the agent's edits changed the session's elements, first version against latest:
`bodyOnly`, `signatureChanged`, `unclassified` — a declaration line missing or one the parser may
have cut, such as an arrow function — `firstSeenAfterEdit` — the first version seen was already
the agent's edit — `contractElementsChanged` and `iacResourcesChanged` — a declaration has no
declaration line to compare, so it is counted as what it is — are disjoint; `exportsChanged` counts
the changed exported ones; counts only, no percentage or threshold; present only when an after-edit
hook reports the agent's edits; JSON only),
`backgroundChanges[]`, `editOscillation[]` (with each symbol's recent hash cycle), `editSource`, and
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
  treated as unchanged. A declaration file is always hashed as a whole as well, so an element its
  model cannot see is still reported by file — see the table above for which part sees what.
- The ledger keeps 2,000 entries per list; older ones are dropped and counted in `dropped`.
- An oscillation is two returns to an earlier version (A → B → A → B). One return (A → B → A) is
  not reported. There is no score and no threshold beyond that count; only the existing opt-in
  `experimental_blocking` panic mode can turn the signal into a block.
