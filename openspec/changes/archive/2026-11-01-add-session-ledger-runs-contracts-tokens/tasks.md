# Tasks — add-session-ledger-runs-contracts-tokens

- [x] Test-command detection: closed runner list + package-manager test scripts + scripts the repository declares in `package.json` + `make test`/`check`
- [x] after-tools on `Bash` (install matcher): count shell commands; record a test run with time, exit status when present, and symbol hashes of edited files
- [x] before-edit: pre-edit hashes for a file first edited after the last run
- [x] before-stop fact: symbols edited after the last run + the tests that reach them; a failed last run; withheld with reason when no shell command was observed
- [x] Docs: install agent-loop hooks, session ledger
- [x] Tests: edit → test → edit names only the second; file first edited after the run; clean / failed run; no run; not observed; non-test command silent
- [x] Moved to `add-session-lease-tokens`: canonical contract/IaC hashes, lease tokens, `lease-current`, session counts
