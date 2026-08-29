/**
 * Generic preset A/B benchmark protocol runner.
 *
 * Dry-run validates the corpus and recomputes deterministic surface quantities at
 * $0. A live run requires a committed rule, a pinned-container attestation, two
 * models, both repo tiers, and a checked-in results path.
 *
 * change: add-benchmark-harness-protocol
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFINITIONS } from '../src/cli/commands/mcp.js';
import { REPOS } from '../scripts/bench-agent.tasks.js';
import { validatePresetBenchmarkCorpus, type PresetBenchmarkCorpus } from '../src/bench/preset-protocol.js';
import { comparePresetSurfaces } from '../src/bench/preset-surface.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function runJson(script: string, args: string[]): unknown {
  const output = execFileSync(process.execPath, ['--import', 'tsx', join(root, script), ...args, '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(output) as unknown;
}

function preregisteredRule(path: string): { path: string; sha256: string; commit: string } {
  const absolute = resolve(root, path);
  const repositoryPath = relative(root, absolute);
  execFileSync('git', ['ls-files', '--error-unmatch', repositoryPath], { cwd: root, stdio: 'ignore' });
  try {
    execFileSync('git', ['diff', '--quiet', '--', repositoryPath], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new Error(`Decision rule must be committed and unchanged before the run: ${repositoryPath}`);
  }
  const commit = execFileSync('git', ['log', '-1', '--format=%H', '--', repositoryPath], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (!commit) throw new Error(`Decision rule has no pre-run commit: ${repositoryPath}`);
  return {
    path: repositoryPath,
    sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
    commit,
  };
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const presetA = arg('--preset-a', 'navigation')!;
  const presetB = arg('--preset-b', 'substrate')!;
  const corpusPath = resolve(root, arg('--corpus', 'bench/corpora/default-surface.json')!);
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as PresetBenchmarkCorpus;
  const comparison = comparePresetSurfaces(presetA, presetB);
  const surfaces = {
    [presetA]: new Set(comparison.presetA.toolIds),
    [presetB]: new Set(comparison.presetB.toolIds),
  };
  const issues = validatePresetBenchmarkCorpus(
    corpus,
    new Set(TOOL_DEFINITIONS.map((tool) => tool.name)),
    surfaces,
  );
  if (issues.length > 0) {
    throw new Error(`Benchmark corpus validation failed:\n${issues.map((issue) => `- ${issue.message}`).join('\n')}`);
  }

  const base = {
    schemaVersion: 1,
    corpus: corpus.id,
    presets: [presetA, presetB],
    environment: {
      image: `${corpus.environment.image}@${corpus.environment.digest}`,
      repositories: REPOS.map(({ id, url, sha, tier }) => ({ id, url, sha, tier })),
    },
    agentConfig: corpus.agentConfig,
    repoTiers: corpus.repoTiers,
    surfaceComparison: comparison,
  };

  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ ...base, dryRun: true, validation: 'passed' }, null, 2)}\n`);
    return;
  }

  const expectedImage = `${corpus.environment.image}@${corpus.environment.digest}`;
  if (!existsSync('/.dockerenv') && !existsSync('/run/.containerenv')) {
    throw new Error('Live runs must execute inside the corpus container, not on the host.');
  }
  if (process.env.OPENLORE_BENCH_IMAGE !== expectedImage) {
    throw new Error(`Live runs must execute in the pinned corpus image. Expected OPENLORE_BENCH_IMAGE=${expectedImage}.`);
  }
  const out = arg('--out');
  if (!out || !out.startsWith('bench/results/')) {
    throw new Error('Live runs require --out bench/results/<name>.json.');
  }
  const rule = preregisteredRule(arg('--rule', 'bench/rules/adr-0023.json')!);
  const models = corpus.agentConfig.models;
  if (models.length < 2) throw new Error('Live protocol runs require at least two models.');

  const runs = models.map((model) => ({
    model,
    selection: runJson('scripts/bench-preset-selection.ts', [
      '--preset-a', presetA,
      '--preset-b', presetB,
      '--corpus', relative(root, corpusPath),
      '--model', model,
    ]),
    completion: runJson('scripts/bench-preset-completion.ts', [
      '--preset-a', presetA,
      '--preset-b', presetB,
      '--model', model,
      '--runs', String(corpus.agentConfig.runs),
    ]),
  }));

  const artifact = {
    ...base,
    generatedAt: new Date().toISOString(),
    rule,
    runs,
    scoring: 'independent oracle plus deterministic post-hoc transcript metrics; no LLM-as-judge',
  };
  const outputPath = resolve(root, out);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
