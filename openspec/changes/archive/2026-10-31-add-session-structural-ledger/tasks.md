# Tasks — add-session-structural-ledger

## Implementation
- [x] Ledger store at `.openlore/session-ledger/<server-pid>.json` (atomic write, fail-open read,
      capped entries with a disclosed drop count, expiry on the panic-state session rule, removed on
      server exit); addresses + hashes only (`src/core/services/session-ledger.ts`)
- [x] Hook-side lookup: the one live server for the worktree; zero or several → withheld with reason
- [x] Record `served` entries from `orient`, `get_function_skeleton`, `get_subgraph`, `search_code`
      top hits, and spec files `orient` names
- [x] Record `edited` hash sequences from the MCP watcher batch handler (`onFilesReindexed`), or
      sampled at tool calls when the watcher runs in a daemon; untracked files counted
- [x] Agent's own edits from the after-edit hook (`check-edit --hook` appends path + time); without
      any report this session, background notes are withheld with the reason
- [x] Background-change detector and note: ≤3 named with file and served time, the rest counted,
      each fact once; neutral wording; a separate content item after the lease note
- [x] Edit-oscillation detector: a symbol takes an earlier hash for the second time (2 returns);
      symbols + hash cycle
- [x] Panic layer input `edit_oscillation` (reuses the oscillation delta; no new constant);
      `experimental_blocking` behavior unchanged
- [x] `openlore status --json` (`session`) and `panic-check` output (`sessionLedger`):
      `backgroundChanges[]`, `editOscillation[]`

## Verification
- [x] Served symbol edited by another process → next response names it; edited by this session →
      not named (`src/core/services/session-ledger.test.ts`)
- [x] Formatting-only change → not named
- [x] A → B → A → B → oscillation reported; A → B → A and A → B → C → D → not reported
- [x] No after-edit hook report → background notes withheld with the reason
- [x] Ledger cap holds; drop count disclosed
- [x] Lease wording guard (no imperatives) still green; full suite green

## Spec
- [x] `mcp-handlers` delta: ADD LeaseNamesBackgroundChangesToServedSymbols
- [x] `mcp-handlers` delta: ADD EditOscillationIsObservedFromContentHashes
