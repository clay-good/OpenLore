## Context

See `proposal.md` — Why. The design-relevant state of the repository today:

- `src/api/index.ts` **statically** re-exports `openloreAnalyze` from `./analyze.js`, which imports
  `analysis-core` → `call-graph` → tree-sitter. Any `import … from 'openlore'` therefore loads the
  analyzer graph eagerly. This single fact settles the placement question the upstream note raised.
- `serve-descriptor.ts` is dependency-light by contract: node builtins plus `isLoopbackHost`. It is
  already the single validator named by `mcp-security: ServeDescriptorValidatedAtEveryReader`.
- `startServe(options: ServeCliOptions): Promise<ServeHandle | undefined>` is CLI-shaped: string
  `port` / `idleTimeout`, a `stop` mode, and **fourteen** `process.exitCode = 1` sites. Only three
  are static-configuration refusals; the rest are runtime outcomes — startup-lock contention, an
  incompatible or draining announced daemon, a token/preset posture mismatch — each of which logs
  and sets the exit code *after* creating `.openlore` and taking the lock.
- `startServe` also has a **reuse** path (`serve.ts:625-632`): when a compatible daemon is already
  announced it logs "reusing" and returns a `ServeHandle` whose `close()` is deliberately
  `async () => {}` — "never tear down a daemon this process didn't start".
- `readAnalysisOwner(repository, analysisDir)` already exists and documents itself as the
  "non-blocking ownership read for status/preflight" — it never acquires, steals, or waits, and
  treats a stale lock as no analysis in progress.
- `.openlore/analysis/fingerprint.json` carries `{ hash, commit, sourceTreeState, computedAt,
  fileCount, analysisConfigHash }`. `computeProjectFingerprint(root, limits)` recomputes `hash` — but
  only *given the configuration input*, and the artifact stores that input's **hash**, never its
  values. `analysisConfigFingerprintInput` folds in `--include` / `--exclude` / `--max-files`, which
  the analyze CLI passes per-invocation and **never persists**: `.openlore/config.json` holds only
  the configured `analysis.{maxFiles,includePatterns,excludePatterns}`.
  `federation/registry.ts` compares stored-vs-live `hash` for peers, and gets away with it because
  it never has to *recompute* one.
- `federation/registry.ts` exposes `listRepos` / `evaluateRepoState` / `repoStatus` (reads) beside
  `saveRegistry` / `addRepo` / `adoptEmptyFingerprints` (writes).
- `GET /health` returns `{ ok, protocolVersion, presetDispatchEnforced, version, root, pid, preset,
  tools, tokenProtected, tokenAuthenticated, draining, uptimeMs }`. `validateServeHealth` is an
  **allowlist projection**: unknown fields are ignored and dropped from the returned `ServeHealth`.
- `src/pi/extension.ts`: `ensureDaemonResult(cwd, overrides?)` accepts a `launch` override;
  `ensureDaemon(cwd)` — the path the default extension takes — does not.

## Goals / Non-Goals

**Goals**

- Publish facts OpenLore already computes, as values, with the existing API contract.
- Keep the descriptor validator a single implementation across the package boundary, without
  importing the analyzer into a host's supervising process.
- Make the daemon a handle a host holds and closes, not a PID it manages.

**Non-Goals**

- No new computation. Every read composes existing functions; nothing here parses, indexes, or
  infers something OpenLore does not already determine.
- No daemon-free in-process tool path (`dispatchTool` stays unexported) — see proposal.
- No change to the MCP tool surface, tool count, presets, or any preset-membership guard.
- No scoped or approximate freshness answer (Decision 4).
- No second trust path into the daemon beside the validated descriptor (Decision 7).

## Decisions

### 1. The descriptor contract gets its own subpath, not `"."`

**Decision:** add exactly one new export subpath, `openlore/serve-descriptor`, backed by a thin
`src/api/serve-descriptor.ts` that re-exports the module. `"."` gains everything else.

**Why.** The upstream note asked for `"."` on the reasoning that the module is dependency-light so
"exporting it does not weigh down `dist/api/index.js`". That is true of the module and false of the
import: `"."` re-exports `openloreAnalyze` statically, so a host importing `readServeDescriptor`
from `"."` loads the analyzer into the process that supervises every workspace — destroying exactly
the property the ask depends on. The dependency-light contract is only observable through a path
that does not transit the analyzer.

This answers upstream's question 1: **a third subpath, and for the dependency story, not for taste.**

**Alternatives rejected.** (a) Lazy `await import()` inside `"."` — the barrel's static re-exports
still load first; it fixes nothing. (b) Splitting the API barrel so `"."` is analyzer-free — a
breaking reshuffle of a published surface, to serve one consumer. (c) A published `openlore/serve`
that carries both the descriptor contract and `openloreServe` — `openloreServe` pulls the daemon
and therefore the analyzer, so co-locating them re-creates the same trap one path further down.

A packlist/`exports` test SHALL assert the subpath resolves and that importing it does not load the
analyzer, so the requirement's last scenario is enforced rather than asserted.

### 2. `openloreServe` needs a side-effect-free startup core, not a wrapper

**Decision:** split `startServe` into a pure-outcome core and a CLI adapter. The core,
`runServe(options)`, returns a discriminated outcome — `{ kind: 'started', handle }`,
`{ kind: 'reusing', existing }`, or `{ kind: 'refused', code, message }` — and never calls
`logger.error` or touches `process.exitCode`. `startServe` becomes the CLI adapter over it, keeping
today's logging and exit codes verbatim. `openloreServe` translates the options
(numeric `port` / `idleTimeoutMs`, no `stop`) and maps `refused` to a thrown `OpenLoreError`.

**Why the first draft of this decision was wrong.** It proposed extracting only the three *static*
refusals and wrapping `startServe` otherwise. That does not hold: eleven of the fourteen exit-code
sites are runtime outcomes reached *after* `.openlore` is created and the startup lock is taken —
lock contention, an incompatible or draining announced daemon, a token or preset posture mismatch.
Under that draft `openloreServe` would log to the host's console and mutate the host's exit code
before it ever got to throw, which is precisely the contract this change exists to honour. A
supervising host cannot own a process that a library it embeds is quietly failing on its behalf.
The extraction has to cover every exit path, not the easy three.

**Decision 2b — the reuse path must not become a lying handle.** `openloreServe` SHALL NOT return
the reuse handle as if it were its own. Closing a handle must stop the server, and the reuse
handle's `close()` is a deliberate no-op; a host that called `close()` and believed it had released
the daemon would leak a live process on every workspace it closed. Instead the outcome is surfaced:
`openloreServe` accepts `ifRunning: 'reject' | 'adopt'` (default `'reject'`).

- `'reject'` throws a typed `SERVE_ALREADY_RUNNING` error carrying the existing daemon's host,
  port and base URL, so the host can address it deliberately.
- `'adopt'` returns a handle explicitly marked `owned: false` whose `close()` **detaches** — it
  releases the host's reference and resolves without stopping a daemon this process did not start.

`ServeHandle` therefore gains a required `owned: boolean`. A host reading `owned` knows whether
`close()` stops a server or merely lets go; a host that ignores it gets the safe default, because
`'reject'` never hands back a handle at all.

**Alternatives rejected.** (a) Wrap `startServe` and inspect `process.exitCode` afterwards — racy,
and the console output has already happened. (b) Duplicate the refusal rules in the API wrapper —
a second security posture for the loopback/token rule, the exact mistake this change fixes for the
descriptor. (c) Let `close()` on a reused daemon actually stop it — it would let one workspace's
shutdown kill the daemon another workspace is using.

### 3. `openloreHealth` answers from disk; a discoverable daemon refines it

**Decision:** disk is authoritative for `runtime` and `index` (+ `indexDegradations`, reusing the
degradation classification `openloreAnalyze` already produces). `repairInProgress` is true when
analysis ownership is live on disk. `watcher` is `'unknown'` unless a daemon is discoverable and
healthy. Discovery is attempted, is never required, and its failure never degrades the result: a
repository with a whole index and no daemon is `ready`, never `unavailable`.

This answers upstream's question 2: **the disk answer is meaningful with no daemon at all**, and it
is the base case rather than a fallback.

**Consequence — the daemon must report its watcher.** Nothing on disk records watcher state, and a
field that can never hold a value is dishonest. `GET /health` therefore gains an **optional**
`watcher: 'healthy' | 'stopped'`, projected through `validateServeHealth` into `ServeHealth` as an
optional field. This is additive: `validateServeHealth` is an allowlist, older daemons simply omit
it, and `SERVE_PROTOCOL_VERSION` is **not** bumped — the bump is reserved for incompatible contract
changes, and an optional field read by a tolerant validator is not one. Against a daemon that omits
it, `watcher` stays `'unknown'`.

**Alternative rejected:** omit `watcher` from `HealthResult` entirely. It is one of the distinctions
a supervising host actually needs (a stopped watcher means a silently ageing index), and the daemon
already knows it.

### 4. `openloreIndexState` compares fingerprints — and the analysis must first persist what it compared under

**Decision:** `fingerprint.json` gains a `fingerprintConfig` field holding the **values**
`analysisConfigFingerprintInput` produced (`includePatterns`, `excludePatterns`, `maxFiles`,
`protectedExcludePatterns`) beside the `analysisConfigHash` it already stores.
`openloreIndexState` recomputes the working-tree hash under *that persisted configuration* and
compares it to `hash`.

**Why this is required, not a nicety.** The first draft said "recompute under the same
configuration input the analysis used" without saying where that input comes from. It cannot come
from `.openlore/config.json`: `--include`, `--exclude` and `--max-files` are per-invocation CLI
inputs that are never persisted, and they feed the fingerprint. An index built with
`openlore analyze --exclude vendor` would be re-fingerprinted under a *different* corpus, and the
function would report `fingerprint-mismatch` on a working tree that had not changed at all — a
false mismatch, which for a host that treats mismatch as a snapshot transition means a spurious
full re-analysis at every checkout. That is the exact cost this function exists to remove. Comparing
`analysisConfigHash` has the same defect: it cannot be computed without the values either.

**An index written before this field exists is not assessable.** Rather than guess a configuration
and emit a confident wrong answer, `openloreIndexState` returns `matchesWorkingTree: false` with
reason `'config-unrecorded'` — a fourth reason meaning "this index predates configuration
persistence; re-run analysis to make freshness assessable". Sound direction only: the function
never claims a match it cannot prove, and never claims a mismatch it cannot distinguish from a
missing input.

The other reasons map onto the existing federation vocabulary: no artifact → `no-index`, artifact
present with no hash → `unbaselined`, hash differs under the recorded configuration →
`fingerprint-mismatch`.

**Answering upstream's question 3: no, it does not want a `files?: string[]` scope.** A scoped
fingerprint cannot answer the question the function is named for. If the caller scopes to files
`A, B` and file `C` changed, an honest implementation must still answer "does not match" — so the
scope buys nothing — and a scoped implementation that answered "matches" would be *unsound*, which
this repository does not ship. `openloreDrift`'s `files` scope is a different question (which of
these specs drifted), so the symmetry is only apparent.

**Cost, stated honestly:** `computeProjectFingerprint` hashes file contents, so this is O(repo
bytes) of I/O — cheap next to analysis (no parsing, no graph, no index write), not free. The
docstring says so; the function does not pretend to be O(1).

**Alternative rejected:** compare git HEAD or `sourceTreeState` instead. Cheaper, and wrong: an
uncommitted edit changes the tree without changing HEAD, and OpenLore indexes the working tree.

### 5. `openloreAnalysisStatus` is `readAnalysisOwner`, published

**Decision:** a thin facade resolving the analysis directory from options and returning
`{ inProgress: false }` when `readAnalysisOwner` returns null. No new locking concept, no new file.

The stale-lock semantics come along unchanged and deliberately: a crashed holder is not an analysis
in progress, which is precisely what a host needs to decide whether starting one would be a
duplicate.

### 6. `openloreFederationList` is a read; the adoption write stays behind the CLI

**Decision:** compose `listRepos` + `repoStatus` (which calls `evaluateRepoState`) and return both
arrays. It SHALL NOT call `adoptEmptyFingerprints` — that baselines empty fingerprints and writes
the registry. A host therefore may observe `unbaselined` where the CLI's status path would have
adopted; that is correct for a caller that has promised not to write, and `ConsultedRepo.reason`
already discloses the caveat.

The `homeDir` is the resolved `rootPath`, matching how the registry is scoped today (per home repo,
`.openlore/federation.json`), not a machine-global store. A missing manifest is an empty list, not
an error.

### 7. Pi: "do not spawn", not "inject an endpoint"

**Decision:** implement the opt-out (`OPENLORE_PI_NO_SPAWN=1` / a `pi` config key), reaching
`ensureDaemon(cwd)` itself and not only the `ensureDaemonResult` seam. With it set, no healthy
discovered daemon yields the existing bounded, retryable `PiDaemonConnectionError` path.

**Answering upstream's question 4: no, an injected endpoint is the worse shape.** A supervised
daemon started through `openloreServe` already publishes `.openlore/serve.json`, so discovery
already finds it — an injected base URL adds nothing but a *second* trust path into the daemon, one
that bypasses the validated descriptor and would need its own coverage under
`ServeDescriptorValidatedAtEveryReader`. The whole point of this change is to have fewer postures,
not more. "Do not spawn" is a policy statement about who owns the process; it needs no new trust.

### 8. Six new files, not one module

New API files mirror the existing one-function-per-file layout (`analyze.ts`, `drift.ts`, …) so the
barrel stays a barrel and the packlist audit keeps a stable shape. `src/api/serve-descriptor.ts`
exists solely as the subpath entry and must import nothing but the descriptor module.

### 9. Optional feature dependencies: the placement is the bug, not the code

**Decision:** move `vite`, `@vitejs/plugin-react`, `react` and `react-dom` and
`@modelcontextprotocol/sdk` from `dependencies` to `optionalDependencies`; delete
`@modelcontextprotocol/server-memory` outright. Convert `mcp.ts`'s three static SDK imports to one
dynamic load inside the command action. Absence fails soft at the command, following
`loadGrammarSoft` and the local embedding service.

**Why it belongs in this change.** The consumer this change serves ships as a single executable
carrying its own Node and OpenLore as a versioned payload. Today that payload includes React, a
Vite toolchain and an MCP SDK the host provably never loads — it drives OpenLore through
`openloreServe`, and `serve.ts` is SDK-free. Shrinking the payload is the same concern as not
loading the analyzer through `"."` (Decision 1): what an embedding host is forced to carry.

**Why it is nearly free.** `view.ts:187-190` *already* dynamic-imports vite and the React plugin,
under a comment saying they are "only needed for `openlore view`". `react` / `react-dom` are
reached only by `.jsx` files vite serves — they are not in the TypeScript import graph at all. For
those four, only the `package.json` stanza changes. `@modelcontextprotocol/sdk` has exactly one
importer (`mcp.ts`), so one file changes. `@modelcontextprotocol/server-memory` has **zero**
references under `src/` — it is a dead dependency dragging a second MCP server and its bin into
every install.

**The line this does not cross.** `optionalDependencies` still installs by default; this makes the
packages *skippable*, not absent. So the requirement is about behaviour under absence, and an audit
guards the "no unreferenced dependency" half so the dead-package case cannot recur silently.

**Alternatives rejected.** (a) `peerDependencies` — would make a normal `npm i openlore` warn and
leave the viewer broken by default, punishing every ordinary user to serve an embedding host.
(b) A separate `openlore-viewer` package — a real option, and a much larger change; it can follow
this one without being blocked by it. (c) Leaving the MCP SDK required because stdio is a
first-class face — the face stays first-class and installed by default; what changes is that a host
using the HTTP daemon can decline a package it never loads.

## Risks / Trade-offs

- **A published subpath is a permanent contract** → It is one narrow module already extracted for
  stability, and `exports` stays closed otherwise. The alternative (hosts copying the validator) is
  a worse permanent contract, held by strangers.
- **Splitting `startServe` into core + adapter touches every startup exit path** → This is the
  largest single risk in the change, and it is deliberate: the partial extraction the first draft
  proposed was unsound (Decision 2). `serve.test.ts` covers each refusal, the reuse path, and the
  draining path today; the adapter must keep every message and exit code byte-identical, and that
  suite is the gate.
- **`ifRunning: 'adopt'` hands back a handle whose `close()` does not stop a server** → It is
  labelled `owned: false` and it is opt-in; the default `'reject'` never returns a handle at all,
  so the unsafe reading is not reachable by accident.
- **Adding `fingerprintConfig` widens an existing artifact** → Additive and read-tolerantly: an
  older `fingerprint.json` simply lacks it and is reported `config-unrecorded` rather than
  mis-answered. No consumer of the artifact reads unknown fields strictly.
- **Optional dependencies can be skipped by an installer flag, breaking a command for a user who
  did not choose that** → The failure is a named package plus its install line, not a stack trace,
  and the CLI itself still starts. This is the posture the tree-sitter grammars already have.
- **`watcher` on `/health` widens the daemon's response** → Optional, allowlist-projected, no
  protocol bump; the payload already discloses far more (root, pid, preset, tool names) to an
  authenticated caller, and the unauthenticated wildcard-bind branch is untouched.
- **`openloreIndexState` is O(repo bytes)** → Documented, not hidden. A host that calls it per
  keystroke will feel it; a host that calls it per checkout will not. No caching is introduced,
  because a cached freshness answer is the bug the function exists to prevent.
- **A host holding a `ServeHandle` can leak a daemon if it never calls `close()`** → The daemon's
  existing idle timeout remains the backstop, and `idleTimeoutMs` is exposed so a host can set its
  own bound rather than disabling it.
- **Publishing reads invites hosts to poll them** → All four are cheap except index-state, whose
  cost is documented; none of them writes, so polling degrades performance, never correctness.

## Migration Plan

Purely additive; nothing to migrate. Ordering follows the upstream sequencing because it front-loads
what removes host-side code:

1. Subpath + descriptor re-export (Decision 1) and `openloreServe` (Decision 2) — together these
   delete a copied security validator and a spawned binary from every embedding host.
2. `openloreHealth` + `openloreIndexState` (Decisions 3, 4) — the facts that let a host report state
   instead of inferring it.
3. `openloreAnalysisStatus` + `openloreFederationList` (Decisions 5, 6).
4. The Pi opt-out (Decision 7) — independent of the rest.
5. Optional-dependency placement (Decision 9) — independent of the rest, and the only step that
   changes what an ordinary install downloads.

Ordering constraint inside step 2: `fingerprintConfig` must be *written* by analysis before
`openloreIndexState` can *read* it, so the artifact change lands first. Until an index is rebuilt,
the function honestly reports `config-unrecorded` — which is why that reason exists rather than
being a migration afterthought.

Rollback is per step: each is a distinct export. Removing one after release would be breaking, so
each lands only with its coverage in `scripts/api-consumer-smoke.mjs` (which exercises the surface
from **outside** the package, the only place the subpath and the no-analyzer-load property are real)
and with `audit:packlist` green.
