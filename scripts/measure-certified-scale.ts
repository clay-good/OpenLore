/**
 * Regenerate the checked-in certified-scale observation manifest.
 *
 * Wall-clock observations describe this run; CI validates the manifest/document contract and
 * equivalence outcomes, not these machine-specific timings as portable regression thresholds.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { McpWatcher } from '../src/core/services/mcp-watcher.js';
import { runAnalysis } from '../src/cli/commands/analyze.js';
import { handleGetMinimalContext } from '../src/core/services/mcp-handlers/analysis.js';
import { ServeWatchRepairCoordinator } from '../src/cli/commands/serve.js';
import { openloreAnalyze } from '../src/api/analyze.js';
import { getDefaultConfig } from '../src/core/services/config-manager.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(REPO_ROOT, 'benchmarks', 'certified-scale-v1.json');
const ENVELOPE_PATH = join(REPO_ROOT, 'docs', 'performance-envelope.md');
const FIXTURE_FILE_COUNT = 24;
const MEASUREMENT_DATE = new Date().toISOString().slice(0, 10);

type Files = Record<string, string>;
type Operation = 'cold' | 'warm' | 'edit' | 'add' | 'delete' | 'rename';

const formatNumber = (value: number): string => value.toLocaleString('en-US', {
  useGrouping: true,
  maximumFractionDigits: 3,
});

function fixtureFiles(): Files {
  const files: Files = {
    'src/service.ts': 'export function target(value: number) { return value + 1; }\n',
  };
  for (let i = 1; i < FIXTURE_FILE_COUNT; i++) {
    files[`src/consumer-${i}.ts`] =
      `export function consumer${i}(value: number) { return target(value) + ${i}; }\n`;
  }
  return files;
}

async function writeFiles(root: string, files: Files): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }
}

async function setup(): Promise<{ root: string; outputPath: string; files: Files; analysisElapsedMs: number }> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-certified-scale-'));
  const outputPath = join(root, '.openlore', 'analysis');
  const files = fixtureFiles();
  await mkdir(outputPath, { recursive: true });
  await writeFile(
    join(root, '.openlore', 'config.json'),
    `${JSON.stringify(getDefaultConfig('nodejs', './openspec'), null, 2)}\n`,
    'utf8',
  );
  await writeFiles(root, files);
  const analysisElapsedMs = await elapsed(async () => {
    await runAnalysis(root, outputPath, { maxFiles: 100, include: [], exclude: [], reExtract: true });
  });
  return { root, outputPath, files, analysisElapsedMs };
}

async function elapsed(run: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await run();
  return Number((performance.now() - started).toFixed(3));
}

async function measureWarm(): Promise<number> {
  const state = await setup();
  try {
    // Prime every generation-verified in-process context cache before starting
    // the timer. The observation below is the second served query, not a cold
    // artifact parse mislabeled as warm.
    await handleGetMinimalContext(state.root, 'consumer1', 'src/consumer-1.ts');
    return await elapsed(async () => {
      await handleGetMinimalContext(state.root, 'consumer1', 'src/consumer-1.ts');
    });
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
}

async function measureMutation(operation: Exclude<Operation, 'cold' | 'warm'>): Promise<number> {
  const state = await setup();
  let releaseBarrier!: () => void;
  let rejectBarrier!: (error: unknown) => void;
  const publicationBarrier = new Promise<void>((resolve, reject) => {
    releaseBarrier = resolve;
    rejectBarrier = reject;
  });
  // The production daemon has sockets keeping its event loop alive while the
  // coordinator's debounce timer is deliberately unref'ed. This standalone
  // measurement process needs an equivalent bounded owner or Node can exit with
  // the publication promise still pending.
  const barrierOwner = setTimeout(
    () => rejectBarrier(new Error(`Timed out waiting for ${operation} publication`)),
    60_000,
  );
  const repair = new ServeWatchRepairCoordinator(() => {
    void openloreAnalyze({ rootPath: state.root, force: true }).then(releaseBarrier, rejectBarrier);
  });
  const watcher = new McpWatcher({
    rootPath: state.root,
    outputPath: state.outputPath,
    embed: false,
    onBatchFlushed: () => repair.schedule(),
    onGraphStale: () => repair.schedule(),
  });
  try {
    return await elapsed(async () => {
      if (operation === 'edit') {
        const path = join(state.root, 'src/service.ts');
        await writeFile(path, 'export function target(value: number) { return value + 2; }\n', 'utf8');
        await watcher.handleChange(path);
      } else if (operation === 'add') {
        const path = join(state.root, 'src/added.ts');
        await writeFile(path, 'export function added(value: number) { return target(value); }\n', 'utf8');
        await watcher.handleChange(path);
      } else if (operation === 'delete') {
        const path = join(state.root, 'src/consumer-23.ts');
        await rm(path);
        await watcher['handleDeletions']([path]);
      } else {
        const oldPath = join(state.root, 'src/consumer-23.ts');
        const newPath = join(state.root, 'src/renamed-consumer.ts');
        await rm(oldPath);
        await writeFile(newPath, state.files['src/consumer-23.ts'], 'utf8');
        await watcher['handleDeletions']([oldPath]);
        await watcher.handleChange(newPath);
      }
      // Publication includes the serve daemon's real quiet-window coordinator
      // and a complete force analysis. Do not stop the clock at the incremental
      // patch receipt: answers are certified only after this barrier converges.
      await publicationBarrier;
    });
  } finally {
    clearTimeout(barrierOwner);
    repair.cancel();
    await rm(state.root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const files = fixtureFiles();
  const bytes = Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content), 0);
  const coldState = await setup();
  const measurements: Record<Operation, number> = {
    cold: coldState.analysisElapsedMs,
    warm: await measureWarm(),
    edit: await measureMutation('edit'),
    add: await measureMutation('add'),
    delete: await measureMutation('delete'),
    rename: await measureMutation('rename'),
  };
  await rm(coldState.root, { recursive: true, force: true });
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  const sourceCommand = 'npm run measure:certified-scale';
  const environmentId = `${platform()}-${arch()}-node-${process.versions.node}`;
  const matrix = Object.entries(measurements).map(([operation, value]) => ({
    operation,
    metric: 'elapsed',
    value,
    unit: 'ms',
    label: 'measured',
    measuredAt: MEASUREMENT_DATE,
    fixture: 'certified-scale-typescript-v1',
    referenceEnvironment: environmentId,
    sourceCommand,
  }));
  matrix.push({
    operation: 'peak-memory', metric: 'maximum-resident-set', value: peakRssBytes,
    unit: 'bytes', label: 'measured', measuredAt: MEASUREMENT_DATE,
    fixture: 'certified-scale-typescript-v1', referenceEnvironment: environmentId, sourceCommand,
  });

  const manifest = {
    schemaVersion: 1,
    projection: 'semantic-answer-v1',
    certifiedTier: {
      id: 'ci-small-v1',
      fixture: {
        id: 'certified-scale-typescript-v1',
        source: 'scripts/measure-certified-scale.ts',
        dimensions: { files: Object.keys(files).length, sourceBytes: bytes, languages: 1, expectedSymbols: 24 },
        label: 'measured',
        measuredAt: MEASUREMENT_DATE,
        referenceEnvironment: environmentId,
        sourceCommand,
      },
      objectives: {
        coldAnalyze: { ceiling: 5_000, unit: 'ms' },
        warmQuery: { ceiling: 100, unit: 'ms' },
        singleFilePublication: { ceiling: 10_000, unit: 'ms' },
        peakMemory: { ceiling: 536_870_912, unit: 'bytes' },
      },
    },
    referenceEnvironment: {
      id: environmentId,
      platform: platform(), arch: arch(), osRelease: release(), node: process.versions.node,
      cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, totalMemoryBytes: totalmem(),
    },
    measurements: matrix,
    equivalence: {
      suite: 'npm run test:equivalence',
      projection: 'semantic-answer-v1',
      requiredRows: [
        'cold-warm-context', 'memo-hit-miss', 'parallel-serial-extraction',
        'precomputed-live-traversal', 'incremental-full-repair',
        'imported-local-structural', 'bm25-cached-uncached',
        'function-vector-repair', 'spec-vector-repair',
      ],
    },
    policy: {
      ci: 'Validate manifest completeness, published-document synchronization, and equivalence outcomes; do not enforce checked-in wall-clock observations as portable thresholds.',
      beyondCertifiedTier: 'best-effort',
    },
  };

  const objectiveRows = [
    ['Cold analyze', manifest.certifiedTier.objectives.coldAnalyze],
    ['Warm query', manifest.certifiedTier.objectives.warmQuery],
    ['Single-file publication', manifest.certifiedTier.objectives.singleFilePublication],
    ['Peak memory', manifest.certifiedTier.objectives.peakMemory],
  ].map(([surface, objective]) => {
    const typed = objective as { ceiling: number; unit: string };
    return `| ${surface} | ${formatNumber(typed.ceiling)} ${typed.unit} |`;
  }).join('\n');
  const observationRows = manifest.measurements.map((measurement) =>
    `| ${measurement.operation} | ${measurement.metric} | ${formatNumber(measurement.value)} ${measurement.unit} | ${measurement.label} |`,
  ).join('\n');
  const dimensions = manifest.certifiedTier.fixture.dimensions;
  const environment = manifest.referenceEnvironment;
  const envelope = `# Certified Scale Envelope

OpenLore certifies the \`${manifest.certifiedTier.id}\` tier: the deterministic, measured
\`${manifest.certifiedTier.fixture.id}\` fixture with ${formatNumber(dimensions.files)} files, ${formatNumber(dimensions.sourceBytes)} source bytes, ${formatNumber(dimensions.languages)} language, and ${formatNumber(dimensions.expectedSymbols)}
expected symbols. The authoritative machine-readable record is
[\`benchmarks/certified-scale-v1.json\`](../benchmarks/certified-scale-v1.json); regenerate its
measured observations with \`${sourceCommand}\`.

## Certified objectives

| Surface | Certified ceiling |
|---|---:|
${objectiveRows}

## Published observations

All values below are **measured**, not extrapolated. They were observed on ${MEASUREMENT_DATE} with
\`${environment.id}\`: ${environment.platform} ${environment.osRelease}, ${environment.cpu}, ${environment.logicalCpus} logical CPUs,
${formatNumber(environment.totalMemoryBytes)} bytes of memory, and Node.js ${environment.node}. The source command was
\`${sourceCommand}\`.

| Operation | Metric | Observation | Label |
|---|---|---:|---|
${observationRows}

Certification also requires all ${manifest.equivalence.requiredRows.length} registered \`${manifest.projection}\` equivalence rows to pass via
\`${manifest.equivalence.suite}\`. CI checks those outcomes and this document's exact agreement with the
manifest; it does not treat machine-specific wall-clock observations as portable thresholds.

## Beyond the certified tier

Repositories larger or more complex than this fixture remain supported on a **best-effort**
performance basis. The certified objectives above do not apply until a larger tier has a complete
cold, warm, edit, add, delete, rename, and peak-memory matrix plus a passing equivalence suite.
`;

  await mkdir(dirname(MANIFEST_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(ENVELOPE_PATH, envelope, 'utf8');
  process.stdout.write(`${MANIFEST_PATH}\n${ENVELOPE_PATH}\n`);
}

await main();
