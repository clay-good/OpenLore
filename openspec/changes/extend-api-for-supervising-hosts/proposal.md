## Why

A supervising host — an agent runtime that holds several working trees open at once, each with its
own session, sandbox, watcher and history — must **hold and close** an OpenLore runtime per working
tree, and must be able to *say* what state that runtime is in. The published surface
(`dist/api/index.js`) gives it analysis and generation, but publishes no **health**, no **index
freshness**, no **daemon lifecycle**, no **serve-descriptor contract**, no **analysis status**, and
no **read of the federation registry**. The `exports` map is closed to two subpaths, so there is no
fallback: `openlore/dist/cli/commands/serve.js` is `MODULE_NOT_FOUND`.

The consequence is not that hosts cannot integrate — one already has (pi-outpost). It is that each
one reimplements facts OpenLore already owns:

- a **hand-copied `serve.json` validator**, one package boundary away from the module extracted
  specifically so that "one threat model must not have three postures"
  (`mcp-security: ServeDescriptorValidatedAtEveryReader`). A copy is a fourth reader that drifts;
- **binary spawning and PID management** where `startServe` already returns a `ServeHandle` whose
  own comment says it exists so callers can shut the server down without signalling the process;
- **inference over the `/health` transport payload** in place of a contract;
- a **forced full re-analysis at every checkout**, because "does the index still represent this
  tree?" has no cheaper answer than `analyze({force:true})`;
- **provoking `AnalysisInProgressError`** as a status probe, because its `owner`/`elapsedMs`/
  `heartbeatAgeMs` are only reachable by starting an analysis that then fails — the honest response
  to which is to not start a competing analysis at all.

Every fact each host re-derives already exists inside OpenLore: `readAnalysisOwner` is already a
"non-blocking ownership read for status/preflight"; `computeProjectFingerprint` +
`.openlore/analysis/fingerprint.json` already answer the freshness question that
`federation/registry.ts` asks about *peer* repos; `AnalyzeResult` already names its own degradation.
This change publishes them.

## What Changes

All additive. No signature change, no behavioural change to an existing function.

**New read functions on the programmatic API** (no writes, no LLM, no provider configuration —
a host that only indexes must never need generation configured):

- `openloreHealth(options?)` → `HealthResult` — functional readiness as a value:
  `runtime`, `index: 'absent'|'building'|'ready'|'degraded'`, `indexDegradations`, `watcher`,
  `repairInProgress`, and a typed `reason` when not ready. Answered from disk; a discoverable
  daemon refines it, never gates it.
- `openloreIndexState(options?)` → `IndexStateResult` — `matchesWorkingTree`, `fingerprint`,
  `reason: 'no-index'|'fingerprint-mismatch'|'unbaselined'`. The same staleness judgement
  `federation/registry.ts` makes about a peer, made about the local tree.
- `openloreAnalysisStatus(options?)` → `AnalysisStatusResult` — `inProgress`, `owner`,
  `elapsedMs`, `heartbeatAgeMs`, over the existing `readAnalysisOwner`. Asks the lock instead of
  tripping over it.
- `openloreFederationList(options?)` → `{ repos, states }` — read-only. Registration stays an
  explicit user act through the CLI and tools.

**Daemon lifecycle as a supervised call**:

- `openloreServe(options): Promise<ServeHandle>` — a typed facade over the existing `startServe`:
  numeric `port`/`idleTimeoutMs`, no `--stop`, and handle-or-**throw** instead of
  `ServeHandle | undefined`. Failures become `OpenLoreError`s rather than a process exit code.

**The serve-descriptor contract, published**:

- `readServeDescriptor`, `readServeDescriptorState`, `validateServeDescriptor`,
  `validateServeHealth`, `serveHttpBaseUrl`, `canonicalServeRoot`, `SERVE_PROTOCOL_VERSION`, and
  the `ServeDescriptor` / `ServeHealth` / `ServeDescriptorRead` types.
- **Not on `"."`.** `src/api/index.ts` statically re-exports `openloreAnalyze`, so importing
  anything from `"."` eagerly loads the analyzer graph. The descriptor module is
  *dependency-light by contract* — node builtins plus the loopback predicate — precisely so an
  embedding host can import it into its own supervising process without the analyzer. Publishing
  it on `"."` would destroy the property the ask depends on. This change therefore opens **one**
  new, narrow subpath, `openlore/serve-descriptor`, and the `exports` map stays closed otherwise.

**Pi extension: let a supervising host be authoritative over the daemon**:

- An opt-out that makes the extension **discover and use** a daemon but never spawn one.
  `ensureDaemonResult` already accepts a `launch` override; the exported `ensureDaemon(cwd)` — the
  path the default extension takes — does not. Without it, a host that already supervises one
  daemon per working tree gets a second, unsupervised process that can outlive the session and
  silently defeats the host's stop-retrying policy.

**Shed the payload a host never loads**:

- `vite`, `@vitejs/plugin-react`, `react` and `react-dom` move from `dependencies` to
  `optionalDependencies`. `view.ts` already dynamic-imports vite and the React plugin behind a
  comment saying they are "only needed for `openlore view`", and `react`/`react-dom` are reached
  only by the `.jsx` files vite serves — neither is in the TypeScript import graph. Their placement
  in `dependencies`, not the code, is what forces every install to carry them.
- `@modelcontextprotocol/sdk` moves to `optionalDependencies`, and `mcp.ts` — its **only** importer
  — loads it dynamically inside the command action rather than at module scope. The HTTP daemon in
  `serve.ts` is SDK-free, so a host that drives OpenLore through `openloreServe` never needs the
  stdio transport at all.
- `@modelcontextprotocol/server-memory` is **removed**: nothing under `src/` references it, and it
  drags a whole second MCP server and its bin into every install.
- Absence is fail-soft at the feature boundary, following the pattern the optional tree-sitter
  grammars and the local embedding service already use: `openlore view` and `openlore mcp` report a
  clear, actionable install line; analysis, the API, and the daemon are unaffected; and the CLI
  never fails to start because an optional package is missing.

**Explicitly not in scope**: exporting `dispatchTool` for a daemon-free in-process path. It would
put the analyzer in the process serving every workspace (the isolation a host exists to provide),
multiply watchers racing to write one `.openlore/analysis`, and replace a tested IPC (loopback
bind, validated descriptor, constant-time token, DNS-rebinding guard, `/health` identity proof)
with a homemade one. The daemon is the right design; this change makes it something a host holds
and closes.

## Capabilities

### New Capabilities

_None._ Every addition extends an existing capability's contract.

### Modified Capabilities

- `api`: adds the four read functions and `openloreServe` to the programmatic surface, with the
  contract they share — read-only, console-silent, `BaseOptions`, typed errors, and no LLM or
  provider configuration required.
- `mcp-security`: extends `ServeDescriptorValidatedAtEveryReader` past the package boundary. An
  embedding host is a reader; the requirement gains an obligation to *publish* the shared
  validator so a host cannot become a fourth reader with a copy, and a constraint that the
  published path stays dependency-light.
- `cli`: the viewer and stdio-MCP command surfaces gain an explicit optional-dependency contract —
  each degrades at its own command with an actionable message, and no optional package may be
  required for the CLI to start or for analysis, the API, or the daemon to run.
- `mcp-quality`: the Pi extension gains a spawn-authority opt-out, so a host that supervises the
  daemon is not raced by the extension's own `ensureDaemon`.

## Impact

- **Code**: new `src/api/health.ts`, `src/api/index-state.ts`, `src/api/analysis-status.ts`,
  `src/api/federation.ts`, `src/api/serve.ts`; re-exports in `src/api/index.ts`; a new
  `src/api/serve-descriptor.ts` re-export entry for the new subpath; `startServe` in
  `src/cli/commands/serve.ts` gains a programmatic entry that returns or throws rather than
  setting `process.exitCode`; `ensureDaemon` in `src/pi/extension.ts` honours the opt-out.
- **Packaging**: `package.json` `exports` gains exactly one subpath (`./serve-descriptor`); four
  packages move from `dependencies` to `optionalDependencies` and one is removed, shrinking what a
  standalone distribution must carry. `mcp.ts` converts three static SDK imports to a dynamic load.
  `audit:packlist` must stay green; `scripts/api-consumer-smoke.mjs`
  (`npm run test:api-consumer`) covers every new export from outside the package.
- **Consumers**: purely additive for existing embedders (OpenSpec CLI, Pi). A host that already
  copied the descriptor validator can delete it.
- **No impact** on the MCP tool surface, tool count, or any preset — none of this is an MCP tool.
