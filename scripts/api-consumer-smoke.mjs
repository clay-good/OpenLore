#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


/** Run a node child with the smoke module hooks installed. */
function runNode(root, args, { cwd, block, trace, allowFailure = false } = {}) {
  const register = join(root, 'scripts', 'optional-absence-register.mjs');
  const env = { ...process.env };
  if (block) env.OPENLORE_SMOKE_BLOCK = block.join(',');
  if (trace) env.OPENLORE_SMOKE_TRACE = trace; else delete env.OPENLORE_SMOKE_TRACE;
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, ['--import', register, ...args], {
        cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (err) {
    if (!allowFailure) throw err;
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/**
 * Start the daemon, call one tool through it, then stop it — all with the optional packages
 * unresolvable, so "the daemon does not need the viewer toolchain or the stdio SDK" is proven
 * rather than assumed.
 */
async function daemonCheck(root, cli, repo, optional) {
  const register = join(root, 'scripts', 'optional-absence-register.mjs');
  const env = { ...process.env, OPENLORE_SMOKE_BLOCK: optional.join(',') };
  delete env.OPENLORE_SMOKE_TRACE;
  const daemon = spawn(process.execPath, ['--import', register, cli, 'serve', '--idle-timeout', '1'], {
    cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let daemonOutput = '';
  daemon.stdout.on('data', (chunk) => { daemonOutput += chunk; });
  daemon.stderr.on('data', (chunk) => { daemonOutput += chunk; });
  try {
    const descriptorPath = join(repo, '.openlore', 'serve.json');
    let descriptor = null;
    for (let attempt = 0; attempt < 60 && descriptor === null; attempt += 1) {
      try { descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')); }
      catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    if (descriptor === null) {
      fail('the HTTP daemon did not announce itself with the optional packages absent', daemonOutput);
    }
    const response = await fetch(`http://${descriptor.host}:${descriptor.port}/tool/get_map`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(descriptor.token ? { 'x-openlore-token': descriptor.token } : {}) },
      body: JSON.stringify({ directory: repo, args: {} }),
      redirect: 'error',
    });
    if (!response.ok) fail('the daemon refused a tool call with the optional packages absent', `HTTP ${response.status}`);
    console.log('api-consumer-smoke: the HTTP daemon served a tool call with the optional packages absent.');
  } finally {
    spawnSync(process.execPath, ['--import', register, cli, 'serve', '--stop'], { cwd: repo, env, encoding: 'utf8' });
    daemon.kill();
  }
}

function fail(what, detail) {
  console.error(`api-consumer-smoke: FAILED — ${what}\n${detail}`);
  process.exit(1);
}

/**
 * The properties that are only real OUTSIDE the package: what a published entry point loads at
 * runtime, and how the CLI behaves when an optional feature package is genuinely unresolvable.
 */
async function runtimeChecks(root, fixture) {
  const cli = join(root, 'dist', 'cli', 'index.js');
  const optional = ['vite', '@vitejs/plugin-react', 'react', 'react-dom', '@modelcontextprotocol/sdk'];

  // 1. The descriptor subpath does not load the analyzer — asserted against RESOLVED specifiers,
  //    not the static import graph, so a lazy require would be caught too.
  const trace = join(fixture, 'descriptor-trace.tsv');
  const probe = join(fixture, 'descriptor-probe.mjs');
  writeFileSync(probe, `
import { readServeDescriptor } from 'openlore/serve-descriptor';
if (typeof readServeDescriptor !== 'function') { console.error('subpath did not export the validator'); process.exit(1); }
`);
  runNode(root, [probe], { cwd: fixture, trace });
  const loaded = readFileSync(trace, 'utf8');
  const forbidden = ['core/analyzer', 'web-tree-sitter', 'tree-sitter-wasms', 'lancedb', 'api/index.js'];
  const leaked = forbidden.filter((needle) => loaded.includes(needle));
  if (leaked.length > 0) fail('openlore/serve-descriptor loaded modules it must not', leaked.join(', '));

  // 2. The CLI starts and lists every command with every optional package absent.
  const help = runNode(root, [cli, '--help'], { cwd: fixture, block: optional }).output;
  for (const command of ['analyze', 'serve', 'view', 'mcp', 'orient']) {
    if (!help.includes(command)) fail('`--help` omitted a command with optional packages absent', command);
  }

  // 3. Analysis works with every optional package absent.
  const repo = join(fixture, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'a.ts'), 'export function alpha(): number { return beta(); }\nexport function beta(): number { return 1; }\n');
  runNode(root, [cli, 'init', '--force'], { cwd: repo, block: optional });
  runNode(root, [cli, 'analyze'], { cwd: repo, block: optional });

  // 4. Each command whose feature is absent names its package and install line — and nothing
  //    surfaces a raw module-resolution error.
  const view = runNode(root, [cli, 'view'], { cwd: repo, block: optional, allowFailure: true });
  if (!view.output.includes('vite') || !view.output.includes('npm install')) {
    fail('`openlore view` did not name its missing package and install command', view.output);
  }
  const mcp = runNode(root, [cli, 'mcp'], { cwd: repo, block: optional, allowFailure: true });
  if (!mcp.output.includes('@modelcontextprotocol/sdk') || !mcp.output.includes('npm install')) {
    fail('`openlore mcp` did not name its missing package and install command', mcp.output);
  }
  if (!mcp.output.includes('openlore serve')) {
    fail('`openlore mcp` did not point at the HTTP daemon as the alternative transport', mcp.output);
  }
  for (const [name, result] of [['view', view], ['mcp', mcp]]) {
    if (result.output.includes('ERR_MODULE_NOT_FOUND')) {
      fail(`\`openlore ${name}\` surfaced a raw module-resolution error`, result.output);
    }
  }

  // 5. The HTTP daemon starts, answers a tool call, and stops — with every optional package absent.
  await daemonCheck(root, cli, repo, optional);

  // 6. `--list-tools` works with the stdio SDK absent: the surface is knowable without a transport.
  const tools = runNode(root, [cli, 'mcp', '--list-tools'], { cwd: repo, block: optional });
  if (!tools.output.includes('orient')) fail('`openlore mcp --list-tools` failed without the SDK', tools.output);
}

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
  openloreAnalysisStatus,
  openloreFederationList,
  openloreHealth,
  openloreIndexState,
  openloreServe,
  ServeAlreadyRunningError,
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
  type AnalysisStatusResult,
  type FederationListResult,
  type HealthReasonCode,
  type HealthResult,
  type IndexStateResult,
  type ServeApiOptions,
  type ServeHandle,
} from 'openlore';
// The descriptor contract is published on its OWN subpath, never on ".": importing it must not
// drag the analyzer into a supervising host (change: extend-api-for-supervising-hosts).
import {
  readServeDescriptor,
  validateServeHealth,
  serveHttpBaseUrl,
  type ServeDescriptor,
  type ServeHealth,
} from 'openlore/serve-descriptor';

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

// The four supervising-host reads, each answering with nothing but a root path.
const health: Promise<HealthResult> = openloreHealth({ rootPath: '.' });
const indexState: Promise<IndexStateResult> = openloreIndexState({ rootPath: '.' });
const analysisStatus: Promise<AnalysisStatusResult> = openloreAnalysisStatus({ rootPath: '.' });
const federation: Promise<FederationListResult> = openloreFederationList({ rootPath: '.' });
void health; void indexState; void analysisStatus; void federation;
declare const readiness: HealthResult;
const readinessCode: HealthReasonCode | undefined = readiness.reasonCode;
void readinessCode;

const serveOptions: ServeApiOptions = { rootPath: '.', port: 0, ifRunning: 'reject' };
declare const handle: ServeHandle;
void handle.owned; void handle.baseUrl; void handle.close();
const serve: Promise<ServeHandle> = openloreServe(serveOptions);
void serve;
void (async () => {
  try { await openloreServe(serveOptions); }
  catch (err) { if (err instanceof ServeAlreadyRunningError) void err.baseUrl; }
})();

declare const descriptor: ServeDescriptor;
void readServeDescriptor('.openlore/serve.json');
void validateServeHealth({}, '.', descriptor);
void serveHttpBaseUrl(descriptor.host, descriptor.port);
declare const served: ServeHealth;
void served.watcher;
`);

  execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', join(fixture, 'tsconfig.json')], {
    cwd: fixture,
    stdio: 'inherit',
  });
  await runtimeChecks(root, fixture);
  console.log('api-consumer-smoke: OK');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
