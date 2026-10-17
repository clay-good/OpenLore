## 1. Publish the serve-descriptor contract (design Decision 1)

- [x] 1.1 Add `src/api/serve-descriptor.ts` re-exporting `readServeDescriptor`,
  `readServeDescriptorState`, `validateServeDescriptor`, `validateServeHealth`, `serveHttpBaseUrl`,
  `canonicalServeRoot`, `SERVE_PROTOCOL_VERSION` and the `ServeDescriptor` / `ServeHealth` /
  `ServeDescriptorRead` types from `src/cli/commands/serve-descriptor.js`, importing nothing else —
  verify `npm run typecheck` passes and the file's import list is exactly that one module.
- [x] 1.2 Add the `./serve-descriptor` subpath to `package.json` `exports` (import + types), leaving
  `"."` and `"./cli"` unchanged — verify `npm run audit:packlist` stays green and the built
  `dist/api/serve-descriptor.js` is in the pack list.
- [x] 1.3 Add a test asserting that importing the built `./serve-descriptor` subpath does **not**
  load the analyzer: resolve it in a child process and assert no `call-graph` / tree-sitter module
  appears in the loaded module set — verify the test fails if the entry re-exports from
  `src/api/index.js` instead.
- [x] 1.4 Extend the descriptor-reader coverage test so an embedding host importing the published
  contract is counted as a reader, and document the subpath in the `mcp-security`
  `ServeDescriptorValidatedAtEveryReader` context — verify the existing coverage test still names any
  unguarded reader.

## 2. Daemon lifecycle as a handle (design Decision 2)

- [x] 2.1 Split `startServe` into a side-effect-free core `runServe(options)` returning
  `{ kind: 'started', handle } | { kind: 'reusing', existing } | { kind: 'refused', code, message }`
  and a CLI adapter that keeps today's logging and exit codes — verify every one of the twelve in-function
  `process.exitCode = 1` sites is reachable only from the adapter (the other three live in
  `stopDaemon`, reached only by the CLI-only `--stop`), and that `runServe` contains no
  `logger.error` and no `process.exitCode` write.
- [x] 2.2 Verify the CLI is byte-identical in behaviour: run `serve.test.ts` and confirm each
  refusal, the reuse path and the draining path emit the same message and the same exit code as
  before the split.
- [x] 2.3 Add `ServeHandle.owned: boolean`, set true for a daemon this process started and false for
  an adopted one whose `close()` detaches — verify the reuse path can no longer produce a handle
  that reports `owned: true` with a no-op `close()`.
- [x] 2.4 Add `src/api/serve.ts` exporting `openloreServe(options): Promise<ServeHandle>` that
  translates numeric `port` / `idleTimeoutMs`, maps every `refused` outcome to a thrown
  `OpenLoreError`, and honours `ifRunning: 'reject' | 'adopt'` with `'reject'` as the default —
  verify a static refusal and a runtime refusal (lock contention) both throw with the exit code and
  console untouched.
- [x] 2.5 Add a test that starting against an already-running compatible daemon throws
  `SERVE_ALREADY_RUNNING` carrying its host, port and base URL when `ifRunning` is unset — verify no
  handle is returned.
- [x] 2.6 Add a test that `ifRunning: 'adopt'` returns a handle with `owned: false` whose `close()`
  resolves and leaves the existing daemon running and discoverable.
- [x] 2.7 Add a test that `openloreServe({ port: 0 })` returns an `owned: true` handle carrying the
  actual bound port and a matching `baseUrl`, and that `close()` stops the server and leaves no live
  daemon at the descriptor — verify no signal is sent to any process.
- [x] 2.8 Re-export `openloreServe`, `ServeApiOptions` and `ServeHandle` from `src/api/index.ts`.

## 3. Readiness as a value (design Decision 3, spec `RuntimeReadinessIsPublishedAsAValue`)

- [x] 3.1 Add an optional `watcher: 'healthy' | 'stopped'` to the `GET /health` payload in
  `src/cli/commands/serve.ts`, sourced from the daemon's freshness watcher — verify a daemon started
  with `--no-watch` reports `stopped` and a watching daemon reports `healthy`.
- [x] 3.2 Project the optional `watcher` field through `validateServeHealth` into `ServeHealth`
  without bumping `SERVE_PROTOCOL_VERSION` — verify a health payload omitting `watcher` still
  validates and yields `undefined`, and that no other field's strictness changed.
- [x] 3.3 Add `src/api/health.ts` exporting `openloreHealth(options?): Promise<HealthResult>`:
  `index` and `indexDegradations` from the on-disk artifact set using the same degradation
  classification `openloreAnalyze` produces, `repairInProgress` from live analysis ownership,
  `watcher` from a discoverable healthy daemon and `'unknown'` otherwise — verify a repository with a
  whole index and no daemon reports `runtime: 'available'`, `index: 'ready'`, `watcher: 'unknown'`.
- [x] 3.4 Add tests for the three spec scenarios: ready with no daemon and no outbound request;
  a missing/corrupt artifact yielding `degraded` naming the artifact and reason; a running daemon
  over an unbuilt index yielding `index: 'absent'` with a typed reason — verify none of the three
  writes a file under the repository.
- [x] 3.5 Re-export `openloreHealth` and `HealthResult` from `src/api/index.ts`.

## 4. Index freshness without re-analysis (design Decision 4, spec `IndexFreshnessIsAnsweredWithoutReanalysis`)

- [x] 4.1 Persist the fingerprint configuration **values** (`includePatterns`, `excludePatterns`,
  `maxFiles`, `protectedExcludePatterns`) as a `fingerprintConfig` field in `fingerprint.json`,
  beside the `analysisConfigHash` already written — verify an analysis run with `--exclude` records
  that exclude in the artifact, and that the field's absence in an older artifact is read
  tolerantly.
- [x] 4.2 Add `src/api/index-state.ts` exporting
  `openloreIndexState(options?): Promise<IndexStateResult>` that reads the artifact, recomputes the
  working-tree hash with `computeProjectFingerprint` under the **recorded** `fingerprintConfig`, and
  compares hashes — verify it acquires no ownership, starts no analysis, and writes nothing.
- [x] 4.3 Map the outcomes to `reason`: absent artifact → `no-index`, artifact with an empty hash →
  `unbaselined`, artifact without `fingerprintConfig` → `config-unrecorded`, differing hash →
  `fingerprint-mismatch` — verify `config-unrecorded` is returned instead of a comparison computed
  under a guessed configuration.
- [x] 4.4 Add the false-mismatch regression test: analyze with `--exclude <dir>`, touch nothing, and
  verify `openloreIndexState` reports a **match** — the test must fail if the recompute falls back to
  the default configuration.
- [x] 4.5 Add tests for the remaining spec scenarios: unchanged tree matches and carries the
  fingerprint; edited tree mismatches with no analysis started; never-analyzed repository reports
  `no-index` distinctly — verify the mismatch case leaves the ownership lock untouched.
- [x] 4.6 Document the O(repo bytes) cost in the function's docstring and its API type, and state
  that no `files` scope is offered because a scoped answer cannot be sound — verify the docstring
  says so rather than implying a cheap call.
- [x] 4.7 Re-export `openloreIndexState` and `IndexStateResult` from `src/api/index.ts`.

## 5. Analysis status and federation read (design Decisions 5, 6)

- [x] 5.1 Add `src/api/analysis-status.ts` exporting `openloreAnalysisStatus(options?)` over
  `readAnalysisOwner`, resolving the analysis directory from options and returning
  `{ inProgress: false }` on a null read — verify a live foreign owner yields `inProgress` with
  owner, `elapsedMs` and `heartbeatAgeMs`, and that no ownership is acquired, stolen, or awaited.
- [x] 5.2 Add a test that a stale lock left by a dead holder reports no analysis in progress —
  verify it matches how `acquireAnalysisOwnership` classifies the same lock.
- [x] 5.3 Add `src/api/federation.ts` exporting `openloreFederationList(options?)` composing
  `listRepos` + `repoStatus` against the resolved `rootPath` as home dir — verify it never calls
  `adoptEmptyFingerprints`, the registry file is byte-identical after the call, and a missing
  manifest yields an empty list rather than an error.
- [x] 5.4 Re-export `openloreAnalysisStatus`, `openloreFederationList` and their result types
  (plus `FederationRepoEntry`, `ConsultedRepo`, `RepoIndexState`) from `src/api/index.ts`.

## 6. The shared read contract (spec `SupervisingHostReadsNeedNoGenerationConfiguration`)

- [x] 6.1 Make all four reads accept `BaseOptions` and run under `withLoggerOptions` so they are
  console-silent by default, honour `signal`, and surface failure as `OpenLoreError` — verify each
  matches the option handling of an existing API function.
- [x] 6.2 Add a test that calls all four reads on a repository with no LLM provider credentials
  configured — verify each returns its value and none throws for missing provider configuration.
- [x] 6.3 Add a test that snapshots the repository tree before and after all four reads — verify no
  file is created or modified.

## 7. Pi spawn-authority opt-out (design Decision 7, spec `PiDaemonSpawnAuthorityIsOverridable`)

- [x] 7.1 Read the opt-out (`OPENLORE_PI_NO_SPAWN` plus the equivalent Pi config key) inside
  `ensureDaemon(cwd)` — not only through the `ensureDaemonResult` `launch` seam — so the default
  extension path honours it; verify the config key survives the config wizard's unknown-key
  preservation.
- [x] 7.2 With the opt-out set and a healthy discovered daemon, use it and launch nothing — verify a
  test asserts no child process was spawned.
- [x] 7.3 With the opt-out set and no discoverable healthy daemon, take the existing bounded,
  retryable `PiDaemonConnectionError` path naming the absent daemon — verify the message does not
  advise `openlore analyze` and the failure stays immediately retryable.
- [x] 7.4 With the opt-out unset, verify the existing spawn behaviour and its bounded failure
  handling are unchanged by the current `extension.test.ts` daemon suite.

## 8. Optional feature dependencies (design Decision 9, spec `OptionalFeatureDependenciesDegradeAtTheirOwnCommand`)

- [x] 8.1 Remove `@modelcontextprotocol/server-memory` from `dependencies` — verify no file under
  `src/` references it and the full test suite still passes.
- [x] 8.2 Move `vite`, `@vitejs/plugin-react`, `react` and `react-dom` to `optionalDependencies`,
  leaving `view.ts`'s existing dynamic imports as they are — verify `npm run build` and
  `npm run typecheck` pass and `openlore view` still starts with them installed.
- [x] 8.3 Move `@modelcontextprotocol/sdk` to `optionalDependencies` and convert `mcp.ts`'s three
  module-scope SDK imports to one dynamic load inside the command action — verify importing
  `src/cli/index.ts` no longer loads the SDK, and `openlore mcp` still serves over stdio.
- [x] 8.4 Add a fail-soft loader for each feature, following `loadGrammarSoft` and the local
  embedding service: on a resolution failure report the missing package plus its install command —
  verify no raw module-resolution error reaches the user.
- [x] 8.5 Add a test that with all four optional packages absent the CLI starts, `--help` lists every
  command, `openlore analyze` succeeds, and the HTTP daemon starts and serves a tool call.
- [x] 8.6 Add a test that `openlore view` and `openlore mcp` each name their missing package and
  install command when it is absent, and that the MCP message points at the HTTP daemon as the
  available alternative transport.
- [x] 8.7 Add a dependency audit asserting every entry in `dependencies` is imported by at least one
  file under `src/` — verify it fails when a package like `server-memory` is reintroduced unused.

## 9. Outside-the-package coverage and gates

- [x] 9.1 Extend `scripts/api-consumer-smoke.mjs` to import and exercise every new export from
  outside the package — the four reads, `openloreServe` + `close()`, and the `./serve-descriptor`
  subpath — verify `npm run test:api-consumer` passes.
- [x] 9.2 Run `npm run lint && npm run typecheck && npm run test:run && npm run audit:packlist` —
  verify all green.
- [x] 9.3 Update the API documentation to list the new exports, the new subpath and why the
  descriptor contract does not live on `"."` — verify any quantitative doc-claim guard still passes.
- [x] 9.4 Run `openspec validate extend-api-for-supervising-hosts --strict` — verify the change
  validates and the four delta specs apply cleanly.
