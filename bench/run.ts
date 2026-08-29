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
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFINITIONS } from '../src/cli/commands/mcp.js';
import { BENCH_AGENT_CORPUS, REPOS } from '../scripts/bench-agent.tasks.js';
import { launchBenchmarkContainer, readBenchmarkContainerSpec } from '../src/bench/container-launch.js';
import { readPreregisteredRule } from '../src/bench/preregistered-rule.js';
import { validatePresetBenchmarkCorpus, type PresetBenchmarkCorpus } from '../src/bench/preset-protocol.js';
import { comparePresetSurfaces } from '../src/bench/preset-surface.js';
import { resolveBenchmarkResultPath } from '../src/bench/result-path.js';
import {
  evaluatePresetBenchmarkRule,
  parsePresetBenchmarkRule,
  type CompletionTierEvidence,
} from '../src/bench/protocol-verdict.js';

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

interface SelectionPayload {
  rows: Array<Record<string, unknown> & { class: string }>;
}

interface CompletionPayload {
  corpus: string;
  repositories: Array<{ id: string; url: string; sha: string; tier: string }>;
  perTier: CompletionTierEvidence[];
  rawArmArtifacts: Record<string, string[]>;
  trajectoryScores: Record<string, unknown>;
}

function sharedSelectionAccuracy(runs: SelectionPayload[], presets: string[]): Record<string, number> {
  return Object.fromEntries(presets.map((preset) => {
    const cells = runs.flatMap((run) => run.rows
      .filter((row) => row.class === 'shared')
      .map((row) => row[preset] as { correct?: boolean }));
    return [preset, cells.length === 0 ? Number.NaN : cells.filter((cell) => cell.correct === true).length / cells.length];
  }));
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

  const expectedBaseImage = `${corpus.environment.image}@${corpus.environment.digest}`;
  const container = readBenchmarkContainerSpec(root, expectedBaseImage);
  const rulePath = arg('--rule', 'bench/rules/adr-0023.json')!;
  const parsedRule = parsePresetBenchmarkRule(JSON.parse(readFileSync(resolve(root, rulePath), 'utf8')) as unknown);

  const base = {
    schemaVersion: 1,
    corpora: { selection: corpus.id, completion: BENCH_AGENT_CORPUS.id },
    presets: [presetA, presetB],
    environment: {
      baseImage: expectedBaseImage,
      containerDefinitionSha256: container.definitionSha256,
      repositories: REPOS.map(({ id, url, sha, tier }) => ({ id, url, sha, tier })),
    },
    agentConfig: corpus.agentConfig,
    repoTiers: corpus.repoTiers,
    surfaceComparison: comparison,
  };

  if (dryRun) {
    process.stdout.write(`${JSON.stringify({
      ...base,
      rule: { id: parsedRule.id, validation: 'passed' },
      dryRun: true,
      validation: 'passed',
    }, null, 2)}\n`);
    return;
  }

  const out = arg('--out');
  const outputPath = resolveBenchmarkResultPath(root, out ?? '');
  if (existsSync(outputPath)) throw new Error(`Benchmark result already exists; choose a fresh --out path: ${out}.`);
  const insideContainer = process.argv.includes('--inside-container');
  const rule = insideContainer
    ? {
      path: process.env.OPENLORE_BENCH_RULE_PATH ?? '',
      sha256: process.env.OPENLORE_BENCH_RULE_SHA256 ?? '',
      commit: process.env.OPENLORE_BENCH_RULE_COMMIT ?? '',
    }
    : readPreregisteredRule(root, rulePath);
  if (!insideContainer) {
    launchBenchmarkContainer(
      root,
      container,
      rule,
      process.argv.slice(2).filter((value) => value !== '--inside-container'),
    );
    return;
  }
  if (!existsSync('/.dockerenv') && !existsSync('/run/.containerenv')) {
    throw new Error('Live runs must execute inside the corpus container, not on the host.');
  }
  if (process.env.OPENLORE_BENCH_DEFINITION_SHA256 !== container.definitionSha256) {
    throw new Error('Live run container definition does not match the checked-in benchmark environment.');
  }
  const runtimeImageId = process.env.OPENLORE_BENCH_RUNTIME_IMAGE_ID ?? '';
  if (!/^sha256:[a-f0-9]{64}$/.test(runtimeImageId)) throw new Error('Live run is missing its Docker image identity.');
  if (!/^[a-f0-9]{40}$/.test(rule.commit) || !/^[a-f0-9]{64}$/.test(rule.sha256) || rule.path !== rulePath) {
    throw new Error('Live run is missing its host-verified pre-registration attestation.');
  }
  const copiedRuleHash = createHash('sha256').update(readFileSync(resolve(root, rule.path))).digest('hex');
  if (copiedRuleHash !== rule.sha256) throw new Error('Copied decision rule differs from the host-verified rule.');
  const models = corpus.agentConfig.models;
  const artifactDirectory = join(dirname(outputPath), `${out!.slice('bench/results/'.length, -'.json'.length)}-artifacts`);
  if (existsSync(artifactDirectory)) {
    const kind = lstatSync(artifactDirectory).isSymbolicLink() ? 'symbolic link' : 'existing path';
    throw new Error(`Benchmark raw-artifact directory is an ${kind}; choose a fresh --out path.`);
  }
  mkdirSync(artifactDirectory, { recursive: false });

  const runs = models.map((model) => ({
    model,
    selection: runJson('scripts/bench-preset-selection.ts', [
      '--preset-a', presetA,
      '--preset-b', presetB,
      '--corpus', relative(root, corpusPath),
      '--model', model,
      '--artifacts-dir', join(artifactDirectory, 'selection'),
    ]),
    completion: runJson('scripts/bench-preset-completion.ts', [
      '--preset-a', presetA,
      '--preset-b', presetB,
      '--model', model,
      '--runs', String(corpus.agentConfig.runs),
      '--artifacts-dir', join(artifactDirectory, 'completion'),
    ]),
  }));

  const selectionRuns = runs.map((run) => run.selection as SelectionPayload);
  const completionRuns = runs.map((run) => run.completion as CompletionPayload);
  for (const completion of completionRuns) {
    if (completion.corpus !== BENCH_AGENT_CORPUS.id) {
      throw new Error(`Completion corpus mismatch: expected ${BENCH_AGENT_CORPUS.id}, received ${completion.corpus}.`);
    }
    if (JSON.stringify(completion.repositories) !== JSON.stringify(base.environment.repositories)) {
      throw new Error('Completion repository pins do not match the checked-in benchmark corpus.');
    }
  }
  const selection = { sharedAccuracy: sharedSelectionAccuracy(selectionRuns, [presetA, presetB]) };
  const completionEvidence = completionRuns.flatMap((run, index) =>
    run.perTier.map((tier) => ({ ...tier, model: models[index] })));
  const verdict = evaluatePresetBenchmarkRule(
    parsedRule,
    presetA,
    presetB,
    comparison.presetB.families,
    selection,
    completionEvidence,
    corpus.repoTiers,
    models.length,
  );

  const artifact = {
    ...base,
    generatedAt: new Date().toISOString(),
    environment: { ...base.environment, runtimeImageId },
    rule: { ...rule, id: parsedRule.id },
    selection,
    completion: completionEvidence,
    rawArmArtifacts: {
      selection: selectionRuns.flatMap((run) => run.rows.flatMap((row) => [presetA, presetB]
        .map((preset) => (row[preset] as { rawArtifact?: string }).rawArtifact)
        .filter((path): path is string => Boolean(path)))),
      completion: completionRuns.flatMap((run) => Object.values(run.rawArmArtifacts).flat()),
    },
    deterministicScores: {
      selection: selectionRuns.map((run, index) => ({ model: models[index], rows: run.rows })),
      completion: completionRuns.map((run, index) => ({ model: models[index], scores: run.trajectoryScores })),
    },
    verdict,
    scoring: 'independent oracle plus deterministic post-hoc transcript metrics; no LLM-as-judge',
  };
  const outputFd = openSync(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(outputFd, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(outputFd);
  }
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
