# Session structural ledger: name what changed under the agent, and see edit loops

> Status: SHIPPED (2026-10-31): the ledger, named background changes, and edit oscillation. Test-run
> facts, contract/IaC hashes, lease tokens, and session counts moved to
> [`add-session-ledger-runs-contracts-tokens`](../add-session-ledger-runs-contracts-tokens/): each
> needs a change that has not shipped. The agent's own edits are identified by the harness's
> after-edit hook, not by the watcher (which sees every process's edits). See
> [docs/session-ledger.md](../../../docs/session-ledger.md).

## The gap

1. **The lease cannot say what changed.** The epistemic lease (`epistemic-lease.ts`) decays on time,
   cognitive load, module-switch density, and "HEAD moved since orient". When another agent, a
   human, or a background job edits a symbol the agent already read, the agent gets — at best — a
   generic "repo moved" note. It is not told *which* symbol it holds a stale picture of.
2. **Edit loops are invisible.** The panic layer (`panic-response.ts`) detects oscillation in *tool
   calls* (the agent bouncing between modules). It does not see *edits*: an agent that changes
   function A, then B to fix A, then reverts A to its earlier text, then changes it again. That loop
   burns turns and tokens and is the typical runaway shape on long tasks.

Both need the same fact: a symbol's normalized content hash at two moments. That hash already
exists (`symbol-content-hash.ts`, PR #520): whitespace and comments do not change it, a real edit
does.

## What changes

- **A per-session ledger** in `.openlore/session-ledger/<server-pid>.json` (atomic writes, fail-open
  reads, bounded size, expires with the session like `panic-state.json`). The session is the MCP
  server process, as for the lease. The hook commands are separate processes: they read the ledger of
  the one live server for their worktree. With zero or several live servers for the worktree, a hook
  withholds ledger facts and `status` says why — it never guesses which session it belongs to. A
  harness with no MCP server (a hook-only setup) gets no ledger facts, disclosed. The ledger holds:
  - **served** — for each symbol returned by `orient`, `get_function_skeleton`, `get_subgraph`,
    `search_code` top hits, and each contract/spec file named in a briefing: its address and content
    hash at the time it was served;
  - **edited** — for each symbol in a file the MCP watcher re-indexes: its address and the sequence of
    content hashes it has had this session.
- **Signal 1 — named background change.** When a served symbol's current hash differs from its served
  hash *and the change did not come from this session's own edits* (its new hash is not one this
  session's watcher batches recorded after an edit the agent made), the next tool response carries a
  neutral factual note: `served earlier: parseConfig (src/config.ts) — its body changed since you read
  it at 14:02`. At most 3 symbols are named, the rest counted. This extends the existing lease
  freshness note (same placement rules, same neutral wording rule — decision 8e95746d); it adds no
  imperative and never blocks.
- **Signal 2 — edit oscillation.** When an edited symbol takes, for the second time in the session, a
  hash it already had earlier (A → B → A → B: two returns; A → B → A: one, not reported), that is an
  observed loop. The ledger reports the symbols and the hash cycle;
  the panic layer takes it as a new input (`edit-oscillation`) alongside its existing signals, and the
  freshness note states it plainly: `parseConfig returned to an earlier version twice this session`.
  The threshold is a count of returns (2), not a weighted score.
- **Signal 3 — tests not run since the last edit.** When the after-tools hook
  (`add-agent-loop-hook-surfaces`; Claude Code `PostToolBatch`, Codex `PostToolUse`, Pi
  `tool_result` — every tool call, not only edits) sees a shell tool call whose command matches a test command the
  repo declares (a `test*` package script, a CI run step, a `test` Makefile target) or a closed list
  of runner invocations (`vitest`, `jest`, `pytest`, `go test`, `cargo test`, …), the ledger records
  the time, the exit status when the payload carries it, and the hashes of the edited symbols at that
  moment. The before-stop receipt then states, for symbols edited after the last recorded run, which
  tests reach them (`select_tests`). It never runs a test. With no hook payloads, the signal is
  withheld with the reason.
- **Dedupe for hooks.** The ledger also records which facts were already delivered this session, so
  the loop hooks never repeat one.
- **Peer publishing.** The `edited` list is published to the peer board when
  `add-peer-footprint-board` ships, so a peer that read a symbol learns this session changed it.
- **Contract and IaC nodes are tracked like code.** Contract elements (`add-service-contract-certification`)
  and IaC resources have no tree-sitter symbol hash, so their served hash is the SHA-256 of the
  element's canonical form (its parsed fields serialized with sorted keys). A reformat of the YAML does
  not change it; a changed path, field, or resource attribute does. "`POST /v1/checkout` (openapi.yaml)
  changed since you read it at 14:02" is then the same note as for a function.
- **A portable lease token.** `orient` and `recall` return a short `leaseToken`: the digest of the
  (address, hash) set they served, registered in the ledger store
  (`.openlore/session-ledger/tokens/`). A sub-agent or orchestrator that holds the token, in any
  process, can ask `verify_claim` (kind `lease-current`, `add-graph-claim-kinds`) which entries changed
  since. The token is a lookup key, not a secret or a signature.
- **Raw session counts, no budget.** `openlore status --json` reports per session: symbols whose body
  changed with the same signature, symbols whose signature changed (the existing signature
  classifier; each symbol counted once), public exports
  changed, contract elements changed, IaC resources changed, and the oscillation and test-run facts.
  These are counts; OpenLore sets no threshold and computes no percentage — a host orchestrator that
  wants a "drift budget" applies its own limits to these numbers.
- **Exposure to harnesses.** `openlore status --json` and the existing `panic-check` hook output carry
  the two signals as data (`backgroundChanges[]`, `editOscillation[]`), so a host orchestrator can
  read them. OpenLore does not halt anything; the existing opt-in `experimental_blocking` mode is the
  only path that can turn a signal into a block, unchanged.

## Honesty contract

A symbol whose file cannot be hashed (unsupported language, parse failure) is not tracked and is
counted as untracked, never reported as unchanged. "Your own edit" vs "background edit" is decided
only by the watcher's record; when the watcher is not running, background-change notes are withheld
and the status says why, rather than guessing. A formatting-only edit is not a change (that is the
hash's design) and the note says "body changed", never "behavior changed".

## Not built

A session id passed by the harness (the session is the MCP server process, as for the lease today);
cumulative "blast-radius percentage" budgets or any threshold (an arbitrary weighted score —
rejected; the raw counts above are what an orchestrator needs); stopping or
sandboxing the agent; recording file contents (only addresses and hashes are stored).

## Relation to other changes

- `add-invalidation-receipts` answers "which commit killed this *memory*". This change answers "which
  symbol you *read* changed under you this session". Different subject, different store; they share
  the hash.
- `add-session-handoff-briefing` can read the ledger's `edited` list as its "in-flight symbols", so a
  successor session sees the same touched set.

## Impact

- Files: ledger store (new, small), hooks into the served-symbol paths of the listed tools, the MCP
  watcher batch handler (hash the re-indexed files' symbols), the lease note builder, the panic
  signal table, `status` and `panic-check` output.
- Specs: `mcp-handlers` — 5 ADDED requirements.
- Tool surface: no new tool. Lease weight table unchanged.
- Risk: ledger growth on long sessions (mitigated: capped entries, oldest dropped, drop count
  disclosed); hash cost on large batches (mitigated: hashes are computed only for files the watcher
  already re-parses).
