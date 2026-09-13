/**
 * Framework entry-point adapters (change: add-framework-entry-point-adapters).
 *
 * Code wired by configuration — a package.json `bin`, a file an npm script runs, a test runner's setup
 * file, a script a CI step runs — is invoked by something outside the call graph, so without this it
 * reads as orphaned and inflates dead-code candidates. Each adapter is a deterministic reader of one
 * declarative format that returns the repository files it names, with a receipt (config file and
 * key). Adapters only ever ADD evidence of use; they never assert that anything is dead.
 *
 * A command counts a file only when the command EXECUTES it: the script a runner (`node`, `tsx`, …)
 * runs, a `--require`/`--import` preload, or a path in command position. A path passed as an argument,
 * a redirect target, or heredoc content is not wiring. What an adapter cannot resolve is a disclosed
 * boundary, never a guess: a variable or `${{ }}` expression, a glob, a `cd` it cannot follow, a module
 * run by name, a missing target, a path outside the repository, a build output with no mapped source,
 * or a config it cannot read or parse. Not read at all (disclosed by the consumers): workspace-member
 * manifests, framework routing conventions, and any other config format.
 */

import { opendir, readdir, stat } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { readArtifactBytesBounded } from '../../utils/bounded-artifact-read.js';
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

export type WiringBoundaryReason =
  | 'dynamic-reference'
  | 'unsupported-form'
  | 'target-not-found'
  | 'build-output-unmapped'
  | 'outside-repository'
  | 'unreadable-config'
  | 'unparsed-config';

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

/** Bytes of one config file read; a larger file is an unreadable-config boundary. */
const CONFIG_MAX_BYTES = 1024 * 1024;
/** Workflow files read from `.github/workflows`; more is disclosed. */
const MAX_WORKFLOW_FILES = 200;
/** Directory entries scanned in `.github/workflows` before giving up on the rest. */
const MAX_WORKFLOW_DIR_ENTRIES = 5_000;
/** References taken from one config file; more is disclosed. */
const MAX_REFERENCES_PER_CONFIG = 1_000;
const MAX_REPORTED_BOUNDARIES = 50;

const TEST_RUNNER_CONFIGS = [
  'vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
  'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs',
  'jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs',
];
const TEST_RUNNER_KEYS = ['setupFiles', 'setupFilesAfterEnv', 'globalSetup', 'globalTeardown'];

/** Commands that run the file named after them. */
const RUNNERS = new Set(['node', 'tsx', 'ts-node', 'bun', 'deno', 'python', 'python3', 'sh', 'bash', 'zsh', 'ruby']);
/** Commands that run the command after them. */
const WRAPPERS = new Set(['env', 'cross-env', 'npx', 'bunx', 'exec', 'time', 'nohup', 'sudo']);
/** Runner flags whose value is a file the runner loads before the script. */
const PRELOAD_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
/** Runner flags that take a value that is not a file. */
const VALUE_FLAGS = new Set(['--env-file', '--inspect-port', '--title', '--cwd', '-I']);
/** Runner flags after which no script file follows (inline code, a module by name). */
const INLINE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);
/** Runner subcommands that precede the script. */
const RUNNER_SUBCOMMANDS = new Set(['watch', 'run']);

interface Reference extends WiringReceipt {
  reference: string;
}

/** Collects one config's references and boundaries, capping references with a disclosure. */
class Collector {
  readonly references: Reference[] = [];
  readonly boundaries: WiringBoundary[] = [];
  private perConfig = new Map<string, number>();

  reference(ref: Reference): void {
    const count = (this.perConfig.get(ref.config) ?? 0) + 1;
    this.perConfig.set(ref.config, count);
    if (count <= MAX_REFERENCES_PER_CONFIG) this.references.push(ref);
    else if (count === MAX_REFERENCES_PER_CONFIG + 1) {
      this.boundary({ config: ref.config, key: '', reference: `more than ${MAX_REFERENCES_PER_CONFIG} references`, reason: 'unsupported-form' });
    }
  }

  boundary(boundary: WiringBoundary): void {
    this.boundaries.push(boundary);
  }
}

/** Read every supported config under `rootPath` and resolve what it wires to repository files. */
export async function collectExternalWiring(rootPath: string): Promise<ExternalWiringReport> {
  const root = resolve(rootPath);
  const out = new Collector();

  const tsconfig = await readTsconfig(root, out);
  await readPackageJson(root, out);
  await readTestRunnerConfigs(root, out);
  await readWorkflows(root, out);

  const receiptsByFile = new Map<string, WiringReceipt[]>();
  for (const ref of out.references) {
    const resolved = await resolveReference(root, ref.reference, tsconfig.outDir, tsconfig.rootDir);
    if (typeof resolved === 'string') {
      const receipts = receiptsByFile.get(resolved) ?? [];
      if (!receipts.some(r => r.config === ref.config && r.key === ref.key)) receipts.push({ config: ref.config, key: ref.key });
      receiptsByFile.set(resolved, receipts);
    } else {
      out.boundary({ ...ref, reason: resolved.reason });
    }
  }

  const wired = [...receiptsByFile]
    .map(([file, receipts]) => ({ file, receipts: receipts.sort(compareReceipts) }))
    .sort((a, b) => compareText(a.file, b.file));
  const seen = new Set<string>();
  const boundaries = out.boundaries
    .filter(b => {
      const key = JSON.stringify([b.config, b.key, b.reference, b.reason]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => compareReceipts(a, b) || compareText(a.reference, b.reference) || compareText(a.reason, b.reason));
  return {
    wired,
    boundaries: boundaries.slice(0, MAX_REPORTED_BOUNDARIES),
    boundariesOmitted: Math.max(0, boundaries.length - MAX_REPORTED_BOUNDARIES),
  };
}

// ── package.json ──────────────────────────────────────────────────────────────

async function readPackageJson(root: string, out: Collector): Promise<void> {
  const config = 'package.json';
  const manifest = await readJsonConfig(root, config, out);
  if (!manifest) return;
  const add = (key: string, value: unknown) => {
    if (typeof value === 'string' && value.length > 0) out.reference({ config, key, reference: value });
  };

  if (typeof manifest.bin === 'string') add('bin', manifest.bin);
  else if (isRecord(manifest.bin)) for (const [name, value] of Object.entries(manifest.bin)) add(`bin.${name}`, value);
  add('main', manifest.main);
  add('module', manifest.module);
  collectExports(manifest.exports, 'exports', out);

  if (isRecord(manifest.scripts)) {
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (typeof command === 'string') commandReferences(command, config, `scripts.${name}`, undefined, out);
    }
  }
  if (isRecord(manifest.jest)) {
    for (const key of TEST_RUNNER_KEYS) {
      for (const value of [manifest.jest[key]].flat()) {
        if (typeof value === 'string') add(`jest.${key}`, expandJestRootDir(value));
      }
    }
  }
}

/** Every string target in an `exports` map, keyed by its condition path; `*` patterns are boundaries. */
function collectExports(value: unknown, key: string, out: Collector): void {
  if (typeof value === 'string') {
    if (/\.d\.[cm]?ts$/.test(value) || value.endsWith('package.json')) return;
    if (value.includes('*')) out.boundary({ config: 'package.json', key, reference: value, reason: 'dynamic-reference' });
    else out.reference({ config: 'package.json', key, reference: value });
    return;
  }
  if (Array.isArray(value)) value.forEach((item, i) => collectExports(item, `${key}[${i}]`, out));
  else if (isRecord(value)) for (const [k, v] of Object.entries(value)) collectExports(v, `${key}["${k}"]`, out);
}

// ── shell commands ────────────────────────────────────────────────────────────

/** A shell word, and whether any part of it was quoted. */
interface Word {
  text: string;
  quoted: boolean;
}

/**
 * The files a shell command executes, relative to `workingDirectory`. After a `cd`, relative
 * references in the rest of the command are boundaries — the adapter does not track the new directory.
 */
function commandReferences(
  command: string,
  config: string,
  key: string,
  workingDirectory: string | undefined,
  out: Collector,
): void {
  let changedDirectory = false;
  for (const segment of shellSegments(command)) {
    const executed = executedWords(segment);
    for (const item of executed) {
      const text = item.word.text;
      if (text.includes('$') || text.includes(GHA_EXPR)) {
        out.boundary({ config, key, reference: text.replaceAll(GHA_EXPR, '${{ }}'), reason: 'dynamic-reference' });
      } else if (item.kind === 'cd') {
        changedDirectory = true;
      } else if (item.kind === 'module') {
        out.boundary({ config, key, reference: text, reason: 'unsupported-form' });
      } else if (/[*?[\]{}]/.test(text) && !item.word.quoted) {
        out.boundary({ config, key, reference: text, reason: 'dynamic-reference' });
      } else {
        const path = text.replaceAll('\\', '/');
        if (changedDirectory && !path.startsWith('/')) {
          out.boundary({ config, key, reference: path, reason: 'unsupported-form' });
        } else {
          out.reference({ config, key, reference: workingDirectory ? posix.join(workingDirectory, path) : path });
        }
      }
    }
  }
}

type Executed = { kind: 'file' | 'module' | 'cd'; word: Word };

/** The command a word names: the basename of an absolute system path (`/usr/bin/env` → `env`). */
function systemCommandName(text: string): string {
  return text.startsWith('/') ? posix.basename(text) : text;
}

/** The words in one simple command that name something it executes. */
function executedWords(words: Word[]): Executed[] {
  let i = 0;
  while (i < words.length) {
    const text = words[i].text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) && !words[i].quoted) { i++; continue; }
    if (WRAPPERS.has(systemCommandName(text))) {
      i++;
      while (i < words.length && words[i].text.startsWith('-')) i++;
      continue;
    }
    if (['pnpm', 'yarn', 'npm'].includes(text) && ['exec', 'dlx'].includes(words[i + 1]?.text ?? '')) { i += 2; continue; }
    break;
  }
  const command = words[i];
  if (!command) return [];
  const name = systemCommandName(command.text);
  if (name === 'cd') return [{ kind: 'cd', word: command }];
  // A bare variable run as the command (`$CMD args`) may execute anything.
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(command.text) || command.text.includes(GHA_EXPR)) {
    return [{ kind: 'file', word: command }];
  }
  if (command.text.includes('$')) return [];
  // A relative path in command position runs that repository file; an absolute one is a system binary.
  if (!command.text.startsWith('/') && /[/\\]/.test(command.text) && /[\w.]/.test(command.text)) {
    return [{ kind: 'file', word: command }];
  }
  if (!RUNNERS.has(name)) return [];

  const executed: Executed[] = [];
  for (let j = i + 1; j < words.length; j++) {
    const word = words[j];
    const [flag, inline] = word.text.startsWith('-') ? word.text.split(/=(.*)/s, 2) : [word.text, undefined];
    if (INLINE_FLAGS.has(flag)) return executed;
    if (flag === '-m') {
      const module = inline ?? words[j + 1]?.text;
      if (module) executed.push({ kind: 'module', word: { text: `-m ${module}`, quoted: false } });
      return executed;
    }
    if (PRELOAD_FLAGS.has(flag)) {
      const value = inline !== undefined ? { text: inline, quoted: word.quoted } : words[++j];
      // A preload named as a package (`--import tsx`) is not a repository file.
      if (value && /^[./]|\.[cm]?[jt]sx?$/.test(value.text)) executed.push({ kind: 'file', word: value });
      continue;
    }
    if (VALUE_FLAGS.has(flag) && inline === undefined) { j++; continue; }
    if (word.text.startsWith('-')) continue;
    if (j === i + 1 && RUNNER_SUBCOMMANDS.has(word.text)) continue;
    executed.push({ kind: 'file', word });
    return executed;
  }
  return executed;
}

/**
 * A command line as simple commands of words: split on `&&`, `||`, `;`, `|`, `&`, and newlines,
 * honoring quotes; `#` comments, redirect targets, and heredoc bodies are dropped.
 */
function shellSegments(command: string): Word[][] {
  const segments: Word[][] = [];
  let words: Word[] = [];
  let word = '';
  let quoted = false;
  let inWord = false;
  let redirect = false;
  const heredocs: string[] = [];

  const endWord = () => {
    if (inWord) {
      if (redirect) redirect = false;
      else words.push({ text: word, quoted });
    }
    word = ''; quoted = false; inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
    redirect = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\n') {
      endSegment();
      // Skip the bodies of heredocs opened on the line just ended.
      for (const delimiter of heredocs.splice(0)) {
        while (i < command.length) {
          const end = command.indexOf('\n', i + 1);
          const line = command.slice(i + 1, end < 0 ? command.length : end);
          i = end < 0 ? command.length : end;
          if (line.trim() === delimiter) break;
        }
      }
      continue;
    }
    if (ch === '\\' && command[i + 1] === '\n') { i++; continue; }  // line continuation
    if (ch === '\\' && command[i + 1] === '\r' && command[i + 2] === '\n') { i += 2; continue; }
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1);
      const end = close < 0 ? command.length : close;
      word += command.slice(i + 1, end);
      quoted = true; inWord = true;
      i = end;
      continue;
    }
    if (ch === '#' && !inWord) {
      const end = command.indexOf('\n', i);
      i = (end < 0 ? command.length : end) - 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    if (ch === ';' || ch === '|' || ch === '&') {
      if (ch === '&' && command[i + 1] === '>') { endWord(); redirect = true; i++; continue; }
      endSegment();
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++;
      continue;
    }
    if (ch === '<' && command[i + 1] === '<') {
      const match = /^<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/.exec(command.slice(i, i + 200));
      if (match) {
        endWord();
        heredocs.push(match[2]);
        i += match[0].length - 1;
        continue;
      }
    }
    if (ch === '>' || ch === '<') {
      // `2>` and `1>`: the digit belongs to the redirect, not a word.
      if (/^\d$/.test(word) && inWord && !quoted) { word = ''; inWord = false; }
      endWord();
      if (command[i + 1] === '>' || command[i + 1] === '&') i++;
      redirect = true;
      continue;
    }
    word += ch;
    inWord = true;
  }
  endSegment();
  return segments;
}

// ── tsconfig.json ─────────────────────────────────────────────────────────────

async function readTsconfig(root: string, out: Collector): Promise<{ outDir?: string; rootDir?: string }> {
  const config = 'tsconfig.json';
  const tsconfig = await readJsonConfig(root, config, out, { jsonc: true });
  if (!tsconfig) return {};
  const options = isRecord(tsconfig.compilerOptions) ? tsconfig.compilerOptions : {};
  if (Array.isArray(tsconfig.files)) {
    for (const file of tsconfig.files) {
      if (typeof file === 'string' && !/\.d\.[cm]?ts$/.test(file)) out.reference({ config, key: 'files', reference: file });
    }
  }
  return {
    outDir: typeof options.outDir === 'string' ? options.outDir : undefined,
    rootDir: typeof options.rootDir === 'string' ? options.rootDir : undefined,
  };
}

// ── test-runner configs ───────────────────────────────────────────────────────

/** Literal `setupFiles` / `globalSetup` values in a vitest, vite, or jest config file. */
async function readTestRunnerConfigs(root: string, out: Collector): Promise<void> {
  for (const config of TEST_RUNNER_CONFIGS) {
    const source = await readConfig(root, config, out);
    if (source === null) continue;
    const code = stripCodeComments(source);
    for (const key of TEST_RUNNER_KEYS) {
      for (const match of code.matchAll(new RegExp(`\\b${key}\\s*:\\s*`, 'g'))) {
        const value = readValueExpression(code, match.index + match[0].length);
        const literals = stringLiterals(value);
        const nonLiteral = value.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '').replace(/[[\],\s]/g, '');
        if (literals === null || nonLiteral.length > 0) {
          out.boundary({ config, key, reference: value.trim().slice(0, 120), reason: 'unparsed-config' });
          continue;
        }
        for (const reference of literals) out.reference({ config, key, reference: expandJestRootDir(reference) });
      }
    }
  }
}

/** The text of one value expression starting at `start`: a bracketed array, a string, or a bare token. */
function readValueExpression(code: string, start: number): string {
  let depth = 0;
  for (let i = start; i < code.length && i < start + 20_000; i++) {
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(code, i);
      if (depth === 0) return code.slice(start, i + 1);
      continue;
    }
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') {
      if (depth === 0) return code.slice(start, i);
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    } else if ((ch === ',' || ch === '\n') && depth === 0) {
      return code.slice(start, i);
    }
  }
  return code.slice(start, Math.min(code.length, start + 20_000));
}

/** The string literals in an array or string expression; `null` when a template has substitutions. */
function stringLiterals(value: string): string[] | null {
  const literals: string[] = [];
  for (const match of value.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    if (match[1] === '`' && match[2].includes('${')) return null;
    literals.push(match[2]);
  }
  return literals;
}

function expandJestRootDir(value: string): string {
  return value.replace(/^<rootDir>\/?/, '');
}

// ── GitHub Actions workflows ──────────────────────────────────────────────────

/** Script files run by workflow `run:` steps, relative to the step's working directory. */
async function readWorkflows(root: string, out: Collector): Promise<void> {
  const dir = '.github/workflows';
  const absoluteDir = join(root, dir);
  const names: string[] = [];
  let scanned = 0;
  try {
    if (!isConfinedPath(root, absoluteDir)) return;
    const handle = await opendir(absoluteDir);
    for await (const entry of handle) {
      if (++scanned > MAX_WORKFLOW_DIR_ENTRIES) break;
      if (/\.ya?ml$/.test(entry.name)) names.push(entry.name);
    }
  } catch {
    return;
  }
  names.sort();
  if (names.length > MAX_WORKFLOW_FILES || scanned > MAX_WORKFLOW_DIR_ENTRIES) {
    out.boundary({ config: dir, key: '', reference: `more than ${MAX_WORKFLOW_FILES} workflow files`, reason: 'unsupported-form' });
  }
  for (const name of names.slice(0, MAX_WORKFLOW_FILES)) {
    const config = `${dir}/${name}`;
    const source = await readConfig(root, config, out);
    if (source === null) continue;
    let workflow: unknown;
    try {
      // No merge keys: `<<` merges of aliases expand exponentially. Plain aliases stay bounded by the
      // parser's alias-count guard.
      const doc = parseDocument(maskExpressions(source), { merge: false });
      if (doc.errors.length > 0) throw new Error('invalid YAML');
      workflow = doc.toJS({ maxAliasCount: 100 });
    } catch {
      out.boundary({ config, key: '', reference: config, reason: 'unparsed-config' });
      continue;
    }
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
      out.boundary({ config, key: 'jobs', reference: config, reason: 'unparsed-config' });
      continue;
    }
    const workflowDir = runDefault(workflow.defaults, 'working-directory');
    const workflowShell = runDefault(workflow.defaults, 'shell');
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) continue;
      const jobDir = runDefault(job.defaults, 'working-directory') ?? workflowDir;
      // A Windows runner's default shell is PowerShell.
      const onWindows = [job['runs-on']].flat().some(label => typeof label === 'string' && /windows/i.test(label));
      const jobShell = runDefault(job.defaults, 'shell') ?? workflowShell ?? (onWindows ? 'pwsh' : undefined);
      job.steps.forEach((step, i) => {
        if (!isRecord(step) || typeof step.run !== 'string') return;
        const key = `jobs.${jobId}.steps[${i}].run`;
        const shell = typeof step.shell === 'string' ? step.shell : jobShell;
        // Only POSIX shell syntax is tokenized; a PowerShell or cmd step is disclosed, not misread.
        if (shell && !/^(bash|sh)\b/.test(shell.trim())) {
          out.boundary({ config, key, reference: `shell ${shell.split(/\s/)[0]}`, reason: 'unsupported-form' });
          return;
        }
        const stepDir = typeof step['working-directory'] === 'string' ? step['working-directory'] : jobDir;
        if (stepDir?.includes(GHA_EXPR)) {
          out.boundary({ config, key, reference: 'working-directory ${{ }}', reason: 'dynamic-reference' });
          return;
        }
        commandReferences(step.run, config, key, stepDir, out);
      });
    }
  }
}

function runDefault(defaults: unknown, name: 'working-directory' | 'shell'): string | undefined {
  if (!isRecord(defaults) || !isRecord(defaults.run)) return undefined;
  const value = defaults.run[name];
  return typeof value === 'string' ? value : undefined;
}

// ── resolution ────────────────────────────────────────────────────────────────

/**
 * A reference as the repository file it names, in the repository's own spelling. A build output under
 * tsconfig `outDir` is tried first as the source it was compiled from (`rootDir`, `.js` → `.ts`). Only a
 * regular file inside the repository resolves.
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
  const out = outDir ? posix.normalize(outDir.replaceAll('\\', '/').replace(/^\.\//, '')).replace(/\/$/, '') : undefined;
  const underOutDir = out !== undefined && out !== '.' && path.startsWith(`${out}/`);
  const bases = [path];
  if (underOutDir && rootDir) {
    bases.unshift(posix.join(posix.normalize(rootDir.replaceAll('\\', '/').replace(/^\.\//, '')), path.slice(out.length + 1)));
  }
  let outside = false;
  for (const base of bases) {
    for (const candidate of sourceVariants(base)) {
      const absolute = join(root, candidate);
      if (!isConfinedPath(root, absolute)) { outside = true; continue; }
      try {
        if ((await stat(absolute)).isFile()) return await repositorySpelling(root, candidate);
      } catch {
        // not this variant
      }
    }
  }
  if (outside) return { reason: 'outside-repository' };
  // A build output whose source tsconfig does not map: the file may well exist, just not here.
  return { reason: underOutDir && !rootDir ? 'build-output-unmapped' : 'target-not-found' };
}

/** A path in the spelling its directories actually use, so a case-insensitive match keys the graph path. */
async function repositorySpelling(root: string, candidate: string): Promise<string> {
  const parts = candidate.split('/');
  const spelled: string[] = [];
  for (const part of parts) {
    try {
      const entries = await readdir(join(root, ...spelled));
      spelled.push(entries.includes(part) ? part : entries.find(e => e.toLowerCase() === part.toLowerCase()) ?? part);
    } catch {
      spelled.push(part);
    }
  }
  return spelled.join('/');
}

/** The path itself, then the TypeScript sources a JavaScript build output is compiled from. */
function sourceVariants(path: string): string[] {
  const swap = (from: RegExp, to: string[]) => from.test(path) ? to.map(ext => path.replace(from, ext)) : [];
  return [
    ...swap(/\.js$/, ['.ts', '.tsx']),
    ...swap(/\.jsx$/, ['.tsx']),
    ...swap(/\.mjs$/, ['.mts']),
    ...swap(/\.cjs$/, ['.cts']),
    path,
  ];
}

// ── reading ───────────────────────────────────────────────────────────────────

/**
 * A config file's text, or `null` when there is none. Read without following links and without
 * blocking (a FIFO at a config path cannot hang the call); a file that exists but cannot be read —
 * a link, a non-regular file, or one over the size cap — is a disclosed boundary.
 */
async function readConfig(root: string, relativePath: string, out: Collector): Promise<string | null> {
  const absolute = join(root, relativePath);
  const read = await readArtifactBytesBounded(absolute, CONFIG_MAX_BYTES);
  if (read.state === 'absent') return null;
  if (read.state === 'refused') {
    out.boundary({ config: relativePath, key: '', reference: relativePath, reason: 'unreadable-config' });
    return null;
  }
  return read.bytes.toString('utf-8');
}

async function readJsonConfig(
  root: string,
  config: string,
  out: Collector,
  options: { jsonc?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const source = await readConfig(root, config, out);
  if (source === null) return null;
  try {
    const parsed: unknown = JSON.parse(options.jsonc ? stripJsonComments(source) : source);
    if (isRecord(parsed)) return parsed;
  } catch {
    // reported below
  }
  out.boundary({ config, key: '', reference: config, reason: 'unparsed-config' });
  return null;
}

/** The index of the closing quote of the string opening at `start`, or the last index. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
  return Math.min(i, source.length - 1);
}

/** Source with `//` and `/* *\/` comments removed; string and template contents are untouched. */
function stripCodeComments(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(source, i);
      out += source.slice(i, end + 1);
      i = end;
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
  return out;
}

/** JSON with comments and trailing commas (tsconfig) as plain JSON; string contents are untouched. */
export function stripJsonComments(source: string): string {
  const code = stripCodeComments(source);
  let out = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') {
      const end = skipString(code, i);
      out += code.slice(i, end + 1);
      i = end;
    } else if (ch === ',' && /^\s*[\]}]/.test(code.slice(i + 1, i + 1 + 4096))) {
      continue;
    } else {
      out += ch;
    }
  }
  return out;
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
