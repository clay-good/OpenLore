# Tasks — add-session-structural-ledger

## Implementation
- [ ] Ledger store at `.openlore/session-ledger/<server-pid>.json` (atomic write, fail-open read,
      capped entries with a disclosed drop count, expiry on the panic-state session rule); addresses +
      hashes only
- [ ] Hook-side lookup: the one live server for the worktree; zero or several → withheld with reason
- [ ] Record `served` entries from `orient`, `get_function_skeleton`, `get_subgraph`, `search_code`
      top hits, and contract/spec files named in a briefing
- [ ] Record `edited` hash sequences from the MCP watcher batch handler (only files it already
      re-parses); untracked files counted
- [ ] Background-change detector: served hash ≠ current hash and the current hash is not one this
      session's edits produced; withheld with a reason when the watcher is not running
- [ ] Lease note: name ≤3 changed served symbols with file and served time, count the rest; neutral
      wording; same placement as the existing note
- [ ] Edit-oscillation detector: a symbol takes an earlier hash for the second time in the session
      (2 returns); report symbols + hash cycle
- [ ] Panic layer input `edit-oscillation` (signal table entry; no new tuning constant beyond the
      return count); `experimental_blocking` behavior unchanged
- [ ] `openlore status --json` and `panic-check` output: `backgroundChanges[]`, `editOscillation[]`

- [ ] Test-run recording from after-tools hook payloads: repo-declared test commands + closed runner
      list; time, exit status if present, edited-symbol hashes at that moment
- [ ] Before-stop fact: symbols edited after the last run + the tests that reach them; withheld
      with reason when no payloads were seen
- [ ] Delivered-fact record for hook dedupe
- [ ] Canonical-form SHA-256 for contract elements and IaC resources (sorted-key serialization of
      parsed fields); tracked in served/edited like code symbols
- [ ] `leaseToken` on `orient` and `recall`: digest of the served (address, hash) set, registered in
      `.openlore/session-ledger/tokens/` (bounded, expiring with the session)
- [ ] `status --json` session counts: body-only, signature-changed (disjoint), exports-changed,
      contract-elements-changed, iac-resources-changed; no thresholds

## Verification
- [ ] Served symbol edited by another process → next response names it; edited by this session →
      not named
- [ ] Formatting-only change → not named
- [ ] A → B → A → B → oscillation reported; A → B → A and A → B → C → D → not reported
- [ ] Watcher off → background notes withheld with the reason in status
- [ ] Ledger cap holds; drop count disclosed
- [ ] Reformatted OpenAPI YAML → no note; changed path in it → note naming the operation
- [ ] A `leaseToken` from session A resolves in a separate process; changed entries listed
- [ ] Session counts match a fixture diff; no percentage or threshold field exists
- [ ] Edit → `npm test` → edit again → before-stop names the second edit's symbols and their tests;
      edit → test with no later edit → nothing
- [ ] Lease wording guard (no imperatives) still green; full suite green

## Spec
- [ ] `mcp-handlers` delta: ADD LeaseNamesBackgroundChangesToServedSymbols
- [ ] `mcp-handlers` delta: ADD EditOscillationIsObservedFromContentHashes
- [ ] `mcp-handlers` delta: ADD EditsAfterTheLastTestRunAreNamed
- [ ] `mcp-handlers` delta: ADD ServedContractsAndResourcesCarryCanonicalHashes
- [ ] `mcp-handlers` delta: ADD LeaseTokensAndSessionCountsAreExposedAsData
