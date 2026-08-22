#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), 'openlore-api-consumer-'));

try {
  mkdirSync(join(fixture, 'node_modules'), { recursive: true });
  symlinkSync(root, join(fixture, 'node_modules', 'openlore'), 'dir');
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
    },
    files: ['consumer.ts'],
  }));
  writeFileSync(join(fixture, 'consumer.ts'), `
import {
  openloreConsolidateDecisions,
  type AnalyzeResult,
  type ConsolidateOptions,
  type ConsolidateResult,
  type GenerateResult,
  type ProgressPhase,
  type RecordDecisionOptions,
  type RunResult,
  type SyncDecisionsOptions,
  type SyncResult,
} from 'openlore';

const record: RecordDecisionOptions = { title: 'Use typed boundaries', rationale: 'Consumers narrow safely' };
const consolidate: ConsolidateOptions = { quiet: true, configPath: 'config/openlore.json' };
const sync: SyncDecisionsOptions = { dryRun: true };
const phase: ProgressPhase = 'decisions';
void record; void sync; void phase;

declare const analysis: AnalyzeResult;
if (analysis.depGraph) void analysis.depGraph.statistics;
void analysis.fromCache;

declare const generation: GenerateResult;
if (!generation.dryRun) void generation.pipelineResult;

declare const run: RunResult;
if (!run.dryRun) void run.init;

const result: Promise<ConsolidateResult> = openloreConsolidateDecisions(consolidate);
declare const syncResult: SyncResult;
void result; void syncResult;
`);

  execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', join(fixture, 'tsconfig.json')], {
    cwd: fixture,
    stdio: 'inherit',
  });
  console.log('api-consumer-smoke: OK');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
