/**
 * Framework entry-point adapters (change: add-framework-entry-point-adapters).
 *
 * Code wired by configuration — a package.json `bin`, an npm script, a test runner's setup file, a
 * CI step's `run:` command — is invoked by something outside the call graph, so without this it reads
 * as orphaned and inflates dead-code candidates. Each adapter is a deterministic reader of one
 * declarative format that returns the repository files it names, with a receipt (config file and
 * key). Adapters only ever ADD evidence of use; they never assert that anything is dead.
 *
 * What an adapter cannot resolve is a disclosed boundary, never a guess: a reference built from a
 * variable or `${{ }}` expression, a target that does not exist, a path outside the repository, or a
 * config it cannot parse. Not read at all (disclosed by the consumers): workspace-member manifests,
 * framework routing conventions, and any other config format.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { readSourceCapped } from './bounded-file-scan.js';
import { isConfinedPath } from '../../utils/path-confinement.js';
import { GHA_EXPR, maskExpressions } from './iac/github-actions.js';

/** Where a wiring reference was read: the config file and the key inside it. */
export interface WiringReceipt {
  config: string;
  key: string;
}

/** A repository file some config invokes, with every receipt that names it. */
export interface ExternalWiring {
  file: string;
  receipts: WiringReceipt[];
}

export type WiringBoundaryReason = 'dynamic-reference' | 'target-not-found' | 'outside-repository' | 'unparsed-config';

/** A reference an adapter saw but could not resolve to a repository file. */
export interface WiringBoundary extends WiringReceipt {
  reference: string;
  reason: WiringBoundaryReason;
}

export interface ExternalWiringReport {
  wired: ExternalWiring[];
  boundaries: WiringBoundary[];
  /** Boundaries beyond {@link MAX_REPORTED_BOUNDARIES}, counted rather than listed. */
  boundariesOmitted: number;
}

/** Bytes of one config file read; larger files are skipped as unparsed. */
const CONFIG_MAX_BYTES = 1024 * 1024;
/** Workflow files read from `.github/workflows`. */
const MAX_WORKFLOW_FILES = 200;
const MAX_REPORTED_BOUNDARIES = 50;

const TEST_RUNNER_CONFIGS = [
  'vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
  'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs',
  'jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs',
];
const TEST_RUNNER_KEYS = ['setupFiles', 'setupFilesAfterEach', 'globalSetup', 'globalTeardown'];

/** A command-line token that names a script file. */
const SCRIPT_PATH = /^[\w@.\-/]+\.(?:[cm]?[jt]sx?|py|sh|rb)$/;
/** Commands that run the file named after them. */
const RUNNERS = new Set(['node', 'tsx', 'ts-node', 'bun', 'deno', 'python', 'python3', 'sh', 'bash', 'ruby']);

interface Reference extends WiringReceipt {
  reference: string;
}

/** Read every supported config under `rootPath` and resolve what it wires to repository files. */
export async function collectExternalWiring(rootPath: string): Promise<ExternalWiringReport> {
  const root = resolve(rootPath);
  const references: Reference[] = [];
  const boundaries: WiringBoundary[] = [];

  const tsconfig = await readTsconfig(root, boundaries);
  references.push(...tsconfig.references);
  references.push(...await readPackageJson(root, boundaries));
  references.push(...await readTestRunnerConfigs(root, boundaries));
  references.push(...await readWorkflows(root, boundaries));

  const receiptsByFile = new Map<string, WiringReceipt[]>();
  for (const ref of references) {
    const resolved = await resolveReference(root, ref.reference, tsconfig.outDir, tsconfig.rootDir);
    if (typeof resolved === 'string') {
      const receipts = receiptsByFile.get(resolved) ?? [];
      if (!receipts.some(r => r.config === ref.config && r.key === ref.key)) receipts.push({ config: ref.config, key: ref.key });
      receiptsByFile.set(resolved, receipts);
    } else {
      boundaries.push({ ...ref, reason: resolved.reason });
    }
  }

  const wired = [...receiptsByFile]
    .map(([file, receipts]) => ({ file, receipts: receipts.sort(compareReceipts) }))
    .sort((a, b) => compareText(a.file, b.file));
  const seen = new Set<string>();
  const sortedBoundaries = boundaries
    .filter(b => {
      const key = JSON.stringify([b.config, b.key, b.reference, b.reason]);
      return !seen.has(key) && seen.add(key);
    })
    .sort((a, b) => compareReceipts(a, b) || compareText(a.reference, b.reference) || compareText(a.reason, b.reason));
  return {
    wired,
    boundaries: sortedBoundaries.slice(0, MAX_REPORTED_BOUNDARIES),
    boundariesOmitted: Math.max(0, sortedBoundaries.length - MAX_REPORTED_BOUNDARIES),
  };
}

// ── package.json ──────────────────────────────────────────────────────────────

async function readPackageJson(root: string, boundaries: WiringBoundary[]): Promise<Reference[]> {
  const config = 'package.json';
  const manifest = await readJsonConfig(root, config, boundaries);
  if (!manifest) return [];
  const refs: Reference[] = [];
  const add = (key: string, value: unknown) => {
    if (typeof value === 'string' && value.length > 0) refs.push({ config, key, reference: value });
  };

  if (typeof manifest.bin === 'string') add('bin', manifest.bin);
  else if (isRecord(manifest.bin)) for (const [name, value] of Object.entries(manifest.bin)) add(`bin.${name}`, value);
  add('main', manifest.main);
  add('module', manifest.module);
  collectExports(manifest.exports, 'exports', refs, boundaries);

  if (isRecord(manifest.scripts)) {
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (typeof command === 'string') refs.push(...commandReferences(command, config, `scripts.${name}`, boundaries));
    }
  }
  if (isRecord(manifest.jest)) {
    for (const key of TEST_RUNNER_KEYS) {
      for (const value of [manifest.jest[key]].flat()) add(`jest.${key}`, value);
    }
  }
  return refs;
}

/** Every string target in an `exports` map, keyed by its condition path; `*` patterns are boundaries. */
function collectExports(value: unknown, key: string, refs: Reference[], boundaries: WiringBoundary[]): void {
  if (typeof value === 'string') {
    if (value.endsWith('.d.ts') || value.endsWith('.d.mts') || value.endsWith('.d.cts')) return;
    if (value.includes('*')) boundaries.push({ config: 'package.json', key, reference: value, reason: 'dynamic-reference' });
    else refs.push({ config: 'package.json', key, reference: value });
    return;
  }
  if (Array.isArray(value)) value.forEach((item, i) => collectExports(item, `${key}[${i}]`, refs, boundaries));
  else if (isRecord(value)) for (const [k, v] of Object.entries(value)) collectExports(v, `${key}["${k}"]`, refs, boundaries);
}

/**
 * The script files a shell command runs. A token after a runner (`node`, `tsx`, …) that is built from
 * a variable or expression is a boundary; flags, globs, and bare words are not file references.
 */
function commandReferences(command: string, config: string, key: string, boundaries: WiringBoundary[]): Reference[] {
  const refs: Reference[] = [];
  const tokens = command.split(/\s+/).map(t => t.replace(/^['"]|['"]$/g, '')).filter(Boolean);
  tokens.forEach((token, i) => {
    const afterRunner = i > 0 && RUNNERS.has(posix.basename(tokens[i - 1]));
    if (token.includes('$') || token.includes(GHA_EXPR)) {
      if (afterRunner) boundaries.push({ config, key, reference: token.replaceAll(GHA_EXPR, '${{ }}'), reason: 'dynamic-reference' });
      return;
    }
    if (!token.startsWith('-') && !token.includes('*') && !token.includes('://') && SCRIPT_PATH.test(token)) {
      refs.push({ config, key, reference: token });
    }
  });
  return refs;
}

// ── tsconfig.json ─────────────────────────────────────────────────────────────

async function readTsconfig(root: string, boundaries: WiringBoundary[]): Promise<{
  references: Reference[]; outDir?: string; rootDir?: string;
}> {
  const config = 'tsconfig.json';
  const tsconfig = await readJsonConfig(root, config, boundaries, { jsonc: true });
  if (!tsconfig) return { references: [] };
  const options = isRecord(tsconfig.compilerOptions) ? tsconfig.compilerOptions : {};
  const references = Array.isArray(tsconfig.files)
    ? tsconfig.files.filter((f): f is string => typeof f === 'string' && !f.endsWith('.d.ts'))
      .map(reference => ({ config, key: 'files', reference }))
    : [];
  return {
    references,
    outDir: typeof options.outDir === 'string' ? options.outDir : undefined,
    rootDir: typeof options.rootDir === 'string' ? options.rootDir : undefined,
  };
}

// ── test-runner configs ───────────────────────────────────────────────────────

/** Literal `setupFiles` / `globalSetup` values in a vitest, vite, or jest config file. */
async function readTestRunnerConfigs(root: string, boundaries: WiringBoundary[]): Promise<Reference[]> {
  const refs: Reference[] = [];
  for (const config of TEST_RUNNER_CONFIGS) {
    const source = await readConfig(root, config);
    if (source === null) continue;
    for (const key of TEST_RUNNER_KEYS) {
      for (const match of source.matchAll(new RegExp(`\\b${key}\\s*:\\s*([^,}\\n]{1,500})`, 'g'))) {
        const value = match[1].trim();
        const list = /^\[([^\]]{0,2000})\]?/.exec(value)?.[1] ?? value;
        const literals = [...list.matchAll(/(['"`])([^'"`$]{1,500})\1/g)].map(m => m[2]);
        if (literals.length === 0 && !/^\[\s*\]?$/.test(value)) {
          boundaries.push({ config, key, reference: value.slice(0, 120), reason: 'unparsed-config' });
        }
        for (const reference of literals) refs.push({ config, key, reference });
      }
    }
  }
  return refs;
}

// ── GitHub Actions workflows ──────────────────────────────────────────────────

/** Script files named by workflow `run:` steps, relative to the step's working directory. */
async function readWorkflows(root: string, boundaries: WiringBoundary[]): Promise<Reference[]> {
  const dir = '.github/workflows';
  let names: string[];
  try {
    names = (await readdir(join(root, dir))).filter(n => /\.ya?ml$/.test(n)).sort().slice(0, MAX_WORKFLOW_FILES);
  } catch {
    return [];
  }
  const refs: Reference[] = [];
  for (const name of names) {
    const config = `${dir}/${name}`;
    const source = await readConfig(root, config);
    if (source === null) continue;
    let workflow: unknown;
    try {
      const doc = parseDocument(maskExpressions(source), { merge: true });
      if (doc.errors.length > 0) throw new Error('invalid YAML');
      workflow = doc.toJS();
    } catch {
      boundaries.push({ config, key: '', reference: config, reason: 'unparsed-config' });
      continue;
    }
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) continue;
    const workflowDir = runWorkingDirectory(workflow.defaults);
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) continue;
      const jobDir = runWorkingDirectory(job.defaults) ?? workflowDir;
      job.steps.forEach((step, i) => {
        if (!isRecord(step) || typeof step.run !== 'string') return;
        const key = `jobs.${jobId}.steps[${i}].run`;
        const stepDir = typeof step['working-directory'] === 'string' ? step['working-directory'] : jobDir;
        for (const ref of commandReferences(step.run, config, key, boundaries)) {
          if (stepDir?.includes(GHA_EXPR)) {
            boundaries.push({ ...ref, reason: 'dynamic-reference' });
          } else {
            refs.push({ ...ref, reference: stepDir ? posix.join(stepDir, ref.reference) : ref.reference });
          }
        }
      });
    }
  }
  return refs;
}

function runWorkingDirectory(defaults: unknown): string | undefined {
  if (!isRecord(defaults) || !isRecord(defaults.run)) return undefined;
  const dir = defaults.run['working-directory'];
  return typeof dir === 'string' ? dir : undefined;
}

// ── resolution ────────────────────────────────────────────────────────────────

/**
 * A reference as the repository file it names, trying the TypeScript source a build output came
 * from (`outDir` → `rootDir`, `.js` → `.ts`). Only a regular file inside the repository resolves.
 */
async function resolveReference(
  root: string,
  reference: string,
  outDir: string | undefined,
  rootDir: string | undefined,
): Promise<string | { reason: WiringBoundaryReason }> {
  const path = posix.normalize(reference.replaceAll('\\', '/').replace(/^\.\//, ''));
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path === '..' || path.startsWith('../')) {
    return { reason: 'outside-repository' };
  }
  // A build output names the source it was compiled from: try that first, so a built `dist/` on disk
  // does not stand in for the code the graph indexes.
  const bases = [path];
  const out = outDir ? posix.normalize(outDir.replace(/^\.\//, '')).replace(/\/$/, '') : undefined;
  if (out && rootDir && path.startsWith(`${out}/`)) {
    bases.unshift(posix.join(posix.normalize(rootDir.replace(/^\.\//, '')), path.slice(out.length + 1)));
  }
  let outside = false;
  for (const base of bases) {
    for (const candidate of sourceVariants(base)) {
      const absolute = join(root, candidate);
      if (!isConfinedPath(root, absolute)) { outside = true; continue; }
      try {
        if ((await stat(absolute)).isFile()) return candidate;
      } catch {
        // not this variant
      }
    }
  }
  return { reason: outside ? 'outside-repository' : 'target-not-found' };
}

/** The path itself, then the TypeScript sources a JavaScript build output is compiled from. */
function sourceVariants(path: string): string[] {
  const swap = (from: RegExp, to: string[]) => from.test(path) ? to.map(ext => path.replace(from, ext)) : [];
  return [
    path,
    ...swap(/\.js$/, ['.ts', '.tsx']),
    ...swap(/\.jsx$/, ['.tsx']),
    ...swap(/\.mjs$/, ['.mts']),
    ...swap(/\.cjs$/, ['.cts']),
  ];
}

// ── reading ───────────────────────────────────────────────────────────────────

async function readConfig(root: string, relativePath: string): Promise<string | null> {
  const absolute = join(root, relativePath);
  if (!isConfinedPath(root, absolute)) return null;
  return readSourceCapped(absolute, CONFIG_MAX_BYTES);
}

async function readJsonConfig(
  root: string,
  config: string,
  boundaries: WiringBoundary[],
  options: { jsonc?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const source = await readConfig(root, config);
  if (source === null) return null;
  try {
    const parsed: unknown = JSON.parse(options.jsonc ? stripJsonComments(source) : source);
    if (isRecord(parsed)) return parsed;
  } catch {
    // reported below
  }
  boundaries.push({ config, key: '', reference: config, reason: 'unparsed-config' });
  return null;
}

/** JSON with comments and trailing commas (tsconfig) as plain JSON; string contents are untouched. */
export function stripJsonComments(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[\]}])/g, '$1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareReceipts(a: WiringReceipt, b: WiringReceipt): number {
  return compareText(a.config, b.config) || compareText(a.key, b.key);
}
