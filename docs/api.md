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

All functions accept an optional `onProgress` callback for status updates and throw errors instead of calling `process.exit`. See [src/api/types.ts](src/api/types.ts) for full option and result type definitions.

### Error handling

All API functions throw `Error` on failure. Wrap calls in try-catch for production use:

```typescript
import { openloreRun } from 'openlore';

try {
  const result = await openloreRun({ rootPath: '/path/to/project' });
  console.log(`Done — ${result.generation.report.filesWritten.length} specs written`);
} catch (err) {
  if ((err as Error).message.includes('API key')) {
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
