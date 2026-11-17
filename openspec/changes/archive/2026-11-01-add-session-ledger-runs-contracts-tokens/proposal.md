# Session ledger, part 2: edits after the last test run

> Status: SHIPPED (2026-11-01). Split from `add-session-structural-ledger`. Canonical contract hashes,
> lease tokens, `lease-current`, and session counts moved to `add-session-lease-tokens`.

## Why

Agents often edit code after their last test run and stop without running the tests again. The
ledger knew the edits but not the runs.

## What changes

| Moment | New |
|--------|-----|
| `after-tools` (now also on `Bash`) | a shell command is counted; a test run (closed runner list, or a test script the repository declares) is recorded with time, exit status when present, and the symbol hashes of the files the session edited |
| `before-edit` | a file first edited after the last run keeps its pre-edit symbol hashes as the run saw them |
| `before-stop` | names the symbols edited after the last run and the tests that reach them (`select_tests`); a failed last run with no later edit; withheld with the reason when no shell command ever reached the hook |

OpenLore runs no test. One record per harness session in `.openlore/session-ledger/test-runs/`.
