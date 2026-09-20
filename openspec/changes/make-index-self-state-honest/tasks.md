# Tasks

## 1. Index capability agreement

- [x] 1.1 Add a capability-agreement predicate to `readReusableIndexes` in
  `src/core/analyzer/analysis-indexes.ts` comparing the resolved embedder against the meta sidecar's
  `hasEmbeddings`; verify with a unit test that a receipt with a resolvable provider over a
  vectorless index is rejected while the unconfigured keyword case is reused
- [x] 1.2 Cover the reverse mismatch (vectors present, no provider resolvable) in the same test file
  and verify the receipt is rejected
- [x] 1.3 Emit a one-line notice naming the mismatch when the gate invalidates a receipt, and verify
  `analyze` prints it exactly once on a repository in that state

## 2. Lock contention and stale locks

- [x] 2.1 Replace the bare `throw` in `withVectorIndexMutation` (`src/core/analyzer/vector-index.ts`)
  with a typed contention outcome carrying the holder's pid, `ageMs` and liveness from the existing
  `LockHeld` descriptor; verify with a unit test that the fields reach the caller
- [x] 2.2 Pass an explicit lock policy at that call site (dead-PID staleness, contention behavior
  chosen by the caller) and verify a lock file naming a dead pid is reclaimed with a stated message
- [x] 2.3 Map the contention outcome in `runEmbedStep` (`src/cli/commands/analyze.ts`): exit non-zero
  naming the holder and lock age when not waiting, wait when `--wait` was given, and keep the
  keyword-fallback notice only for genuine provider failures; verify with a test that starts a
  second build against a held lock and asserts a non-zero exit and no keyword-only index write
- [x] 2.4 Plumb `--wait` through to the index build path and verify the waiting build produces an
  index whose capability matches the resolved provider

## 3. Failure visibility in the receipt

- [x] 3.1 Record watcher embed failures (`src/core/services/mcp-watcher.ts`) into the index receipt's
  `degraded[]` with the endpoint and a timestamp; verify with a test that a failing embed run leaves
  the entry in `analysis-indexes.json`
- [x] 3.2 Verify a subsequent successful build clears the entry, with a test asserting the receipt
  carries no stale failure

## 4. Doctor reports the served mode

- [x] 4.1 Add a `Retrieval mode` check to `src/cli/commands/doctor.ts` using `servedRetrievalMode`;
  verify it reports the semantic mode on a vectored index and the keyword default on an
  unconfigured repository
- [x] 4.2 Raise a finding when a provider resolves and the index carries no vectors, naming the
  remedy; verify the finding is absent on an unconfigured repository and present on a configured one
- [x] 4.3 Surface any `degraded[]` embed failure from the receipt in the same check and verify it is
  reported from a fixture receipt
- [x] 4.4 Keep the existing endpoint check unchanged as its own line and verify both lines appear
  with independent verdicts

## 5. `openlore status`

- [x] 5.1 Add `src/cli/commands/status.ts` reporting served mode, build time, working-tree staleness
  and the cause of keyword mode; register it in `src/cli/index.ts` and verify `openlore status`
  no longer reports `unknown command`
- [x] 5.2 Add `--json` with the same fields and verify the JSON shape in a test
- [x] 5.3 Verify the command is read-only: assert in a test that no index file, lock or receipt
  mtime changes across a run
- [x] 5.4 Handle a repository with no analysis directory by naming the command that builds one, and
  verify the exit status is zero for that case

## 6. Specs and verification

- [x] 6.1 Run `openspec validate --change make-index-self-state-honest --strict` and verify it passes
- [x] 6.2 Run the reaching tests selected by `openlore select-tests` for the changed symbols and
  verify the suite is green
- [x] 6.3 Reproduce the original failure end to end: configure a remote provider, build with the
  endpoint down, and verify `doctor` and `status` both report the unrealized provider instead of a
  clean verdict
