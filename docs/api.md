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
