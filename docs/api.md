## Programmatic API

openlore exposes a typed Node.js API for integration into other tools (like [OpenSpec CLI](https://github.com/Fission-AI/OpenSpec)). Every CLI command has a corresponding API function that returns structured results instead of printing to the console.

```bash
npm install openlore
```

```typescript
import { openloreAnalyze, openloreDrift, openloreRun } from 'openlore';

// Run the full pipeline
const result = await openloreRun({
  rootPath: '/path/to/project',
  adr: true,
  onProgress: (event) => console.log(`[${event.phase}] ${event.step}`),
});
console.log(`Generated ${result.generation.report.filesWritten.length} specs`);

// Check for drift
const drift = await openloreDrift({
  rootPath: '/path/to/project',
  failOn: 'warning',
});
if (drift.filesOmitted > 0) {
  console.warn(`Drift result is partial: ${drift.filesOmitted} changed files were omitted`);
} else if (drift.hasDrift) {
  console.warn(`${drift.summary.total} drift issues found`);
}

// Static analysis only (no API key needed)
const analysis = await openloreAnalyze({
  rootPath: '/path/to/project',
  maxFiles: 1000,
});
console.log(`Analyzed ${analysis.repoMap.summary.analyzedFiles} files`);
if (analysis.fromCache) console.log('Reused the current analysis');
if (analysis.degraded) console.warn(`${analysis.degraded.artifact}: ${analysis.degraded.reason}`);
```

### API Functions

| Function | Description | API Key |
|----------|-------------|---------|
| `openloreInit(options?)` | Initialize config and openspec directory | No |
| `openloreAnalyze(options?)` | Run static analysis | No |
| `openloreGenerate(options?)` | Generate specs from analysis | Yes |
| `openloreVerify(options?)` | Verify spec accuracy | Yes |
| `openloreDrift(options?)` | Detect spec-to-code drift | No* |
| `openloreRun(options?)` | Full pipeline: init + analyze + generate | Yes |
| `openloreAudit(options?)` | Parity audit: uncovered functions, hub gaps, orphan requirements, stale domains | No |
| `openloreGetSpecRequirements(options?)` | Read requirement blocks from generated specs | No |
| `openloreHealth(options?)` | Functional readiness: runtime, index state and degradations, watcher, repair-in-progress | No |
| `openloreIndexState(options?)` | Does the persisted index still represent the working tree? | No |
| `openloreAnalysisStatus(options?)` | Is an analysis running right now, and who owns it? | No |
| `openloreFederationList(options?)` | The federation registry and each repo's index state (read-only) | No |
| `openloreServe(options?)` | Start the local HTTP daemon in-process and get a `ServeHandle` | No |

\* `openloreDrift` requires an API key only when `llmEnhanced: true`.

The shared API options include `rootPath`, `configPath`, `quiet`, and an optional `onProgress` callback. API calls are console-silent by default (`quiet: true`); progress is delivered only through the callback. They never call `process.exit`. See [src/api/types.ts](../src/api/types.ts) for the full option and result definitions.

When `configPath` is supplied, APIs that require existing configuration use that exact project-relative or absolute file and report a missing file as `OpenLoreError` with `code: 'no-config'`. `openloreInit` creates the requested configuration when it is missing. `openloreRun({ dryRun: true })` stays read-only and reports `configSchemaVersion: 'unknown'` when the requested configuration does not exist. APIs use the default `.openlore/config.json` only when `configPath` is omitted.

`openloreAnalyze` uses the same analysis and index builders as the CLI. Its result reports `fromCache`, leaves `depGraph` absent when that artifact is unavailable, and explains partial artifacts or indexes through `degraded` and `indexDegradations`.

Generation and run results are discriminated by `dryRun`. A dry run has `dryRun: true` and no fabricated `pipelineResult`; a completed generation has `dryRun: false` and a real `pipelineResult`. `openloreRun({ dryRun: true })` is read-only and returns the stages it would run.

```typescript
const generated = await openloreGenerate({ rootPath: '/path/to/project', dryRun: preview });
if (generated.dryRun) {
  console.log(generated.report.nextSteps);
} else {
  console.log(generated.pipelineResult);
}
```

### Supervising-host reads

A host that runs OpenLore for many working trees needs facts OpenLore already owns — is it ready,
is the index still current, is an analysis already running, what does a federated answer cover — and
has otherwise had to infer them by provoking work. These four reads answer them directly. None
writes anything, none needs an LLM provider, all are console-silent, all honour `signal`.

```typescript
import { openloreHealth, openloreIndexState, openloreAnalysisStatus, openloreFederationList } from 'openlore';

const health = await openloreHealth({ rootPath });
if (health.index === 'degraded') console.warn(health.indexDegradations);
// `reasonCode` is the typed switch ('no-index' | 'building' | 'analysis-changed' | …);
// `reason` beside it is the human sentence — never parse that one.
// `watcher` is 'unknown' unless a daemon is discoverable: a stopped watcher and an unobservable
// one are different facts, and neither is guessed.

const state = await openloreIndexState({ rootPath });
if (!state.matchesWorkingTree) console.log(`re-analysis needed: ${state.reason}`);
```

`openloreIndexState` re-hashes the analyzed corpus, so it is O(repo bytes) of I/O — cheap next to an
analysis, but not an O(1) metadata check. Call it per checkout, not per keystroke. It compares under
the configuration the index recorded; an index built before that field existed reports
`config-unrecorded` rather than a guessed (and possibly false) mismatch.

`openloreFederationList` never baselines an unbaselined entry — that write stays behind the CLI — so
a host may see `unbaselined` where `openlore federation status` would have adopted the live hash.

### Running the daemon in-process

```typescript
import { openloreServe, ServeAlreadyRunningError } from 'openlore';

const handle = await openloreServe({ rootPath, port: 0, ifRunning: 'reject' });
console.log(handle.baseUrl, handle.owned); // owned: true — close() really stops it
await handle.close();
```

`ifRunning` defaults to `'reject'`, which throws `ServeAlreadyRunningError` carrying the running
daemon's host, port and base URL. `'adopt'` instead returns a handle marked `owned: false` whose
`close()` detaches without stopping a daemon this process did not start — so `close()` never lies
about what it did.

### The `openlore/serve-descriptor` subpath

`.openlore/serve.json` is an attacker-writable artifact whose host/port a reader then fetches and
POSTs tool arguments to. A host that discovers a daemon must validate it with the SAME validator
OpenLore uses, not a copy — so the validator is published:

```typescript
import { readServeDescriptor, validateServeHealth, serveHttpBaseUrl } from 'openlore/serve-descriptor';
```

It is a **separate subpath, deliberately not on `"."`**. The package root re-exports the analyzer-backed
functions statically, so importing anything from `"."` loads the analyzer — which would defeat the
whole point for a supervising process that only needs 100 lines of validation. The subpath imports
node builtins and the loopback predicate, and nothing else; a test asserts it never reaches the
analyzer, both statically and at runtime.

### Optional feature dependencies

The graph viewer's toolchain (`vite`, `@vitejs/plugin-react`, `react`, `react-dom`) and the stdio MCP
transport SDK (`@modelcontextprotocol/sdk`) are `optionalDependencies`, loaded at their own command.
They install by default; an installation that skips them still starts the CLI, lists every command,
runs analysis, serves the HTTP daemon, and drives the whole programmatic API. `openlore view` and
`openlore mcp` then report the missing package and its install command rather than a module-
resolution error.

### Error handling

API boundaries throw `OpenLoreError` on failure. The stable API codes are `no-config`, `no-analysis`, `no-api-key`, and `pipeline-failed`; pipeline failures preserve the original error as `cause`.

```typescript
import { OpenLoreError, openloreRun } from 'openlore';

try {
  const result = await openloreRun({ rootPath: '/path/to/project' });
  console.log(`Done — ${result.generation.report.filesWritten.length} specs written`);
} catch (err) {
  if (err instanceof OpenLoreError && err.code === 'no-api-key') {
    console.error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY');
  } else {
    console.error('openlore failed:', (err as Error).message);
  }
}
```

### Reading generated spec requirements

After running `openloreGenerate`, you can programmatically query the requirement-to-function mapping:

```typescript
import { openloreGetSpecRequirements } from 'openlore';

const { requirements } = await openloreGetSpecRequirements({ rootPath: '/path/to/project' });
for (const [key, req] of Object.entries(requirements)) {
  console.log(`${key}: ${req.title} (${req.specFile})`);
}
```
