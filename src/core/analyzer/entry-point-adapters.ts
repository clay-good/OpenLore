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
/** `setupFiles`-style keys read from one test-runner config; more is disclosed. */
const MAX_KEY_MATCHES_PER_CONFIG = 20;
/** Distinct boundaries kept from one config file; more is counted. */
const MAX_BOUNDARIES_PER_CONFIG = 100;
const MAX_REPORTED_BOUNDARIES = 50;

const TEST_RUNNER_CONFIGS = [
  'vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
  'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs',
  'jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs',
];
const TEST_RUNNER_KEYS = ['setupFiles', 'setupFilesAfterEnv', 'globalSetup', 'globalTeardown'];

/** How one runner takes its script: flags that take a value, flags after which no script follows. */
interface RunnerSyntax {
  valueFlags: Set<string>;
  inlineFlags: Set<string>;
  /** Flags whose value is a file loaded before the script. */
  preloadFlags?: Set<string>;
  subcommands?: Set<string>;
  /** Names a module rather than a file (`python -m pkg`). */
  moduleFlag?: string;
  /** Subcommands after which nothing file-like runs (`bun test`, `deno fmt`). */
  toolSubcommands?: Set<string>;
  /** Whether the inline flag's value is itself a shell command (`sh -c "node x.js"`). */
  runsInline?: boolean;
}
const NODE_LIKE: RunnerSyntax = {
  valueFlags: new Set([
    '--env-file', '--inspect-port', '--title', '--stack-size', '--max-old-space-size', '--conditions', '-C', '--input-type',
    '--cpu-prof-dir', '--heap-prof-dir', '--diagnostic-dir', '--redirect-warnings', '--experimental-config-file', '--watch-path',
  ]),
  inlineFlags: new Set(['-e', '--eval', '-p', '--print']),
  preloadFlags: new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']),
  subcommands: new Set(['watch']),
};
const TS_RUNNER: RunnerSyntax = {
  ...NODE_LIKE,
  valueFlags: new Set([...NODE_LIKE.valueFlags, '--tsconfig', '-P', '--project', '--compiler', '-O', '--compiler-options']),
};
const SHELL: RunnerSyntax = {
  valueFlags: new Set(['-o', '-O', '+o', '+O', '--rcfile', '--init-file']),
  inlineFlags: new Set(['-c']),
  runsInline: true,
};
const RUNNERS = new Map<string, RunnerSyntax>([
  ['node', NODE_LIKE],
  ['tsx', TS_RUNNER],
  ['ts-node', TS_RUNNER],
  ['bun', {
    ...NODE_LIKE,
    subcommands: new Set(['run']),
    toolSubcommands: new Set(['test', 'install', 'i', 'add', 'remove', 'rm', 'update', 'x', 'build', 'upgrade', 'pm', 'create', 'init', 'link', 'unlink', 'publish', 'outdated']),
  }],
  ['deno', {
    // Deno's permission flags take a value only with `=`; they are not listed here.
    valueFlags: new Set(['--config', '-c', '--import-map']),
    inlineFlags: new Set(['eval']),
    subcommands: new Set(['run']),
    toolSubcommands: new Set(['task', 'test', 'fmt', 'lint', 'check', 'install', 'compile', 'bench', 'doc', 'info', 'repl', 'serve', 'upgrade', 'cache', 'coverage', 'publish', 'add', 'remove', 'init']),
  }],
  ['python', { valueFlags: new Set(['-W', '-X', '-Q']), inlineFlags: new Set(['-c']), moduleFlag: '-m' }],
  ['python3', { valueFlags: new Set(['-W', '-X', '-Q']), inlineFlags: new Set(['-c']), moduleFlag: '-m' }],
  ['sh', SHELL], ['bash', SHELL], ['zsh', SHELL],
  ['ruby', { valueFlags: new Set(['-I', '-r', '-C', '-E']), inlineFlags: new Set(['-e']) }],
]);
/** Runners that resolve an extensionless script the way Node does. */
const NODE_RESOLVING = new Set(['node', 'tsx', 'ts-node', 'bun']);
/** Commands that run the command after them, with their options that take a value. */
const WRAPPERS = new Map<string, Set<string>>([
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S'])],
  ['cross-env', new Set()], ['npx', new Set(['-p', '--package'])], ['bunx', new Set()],
  ['exec', new Set(['-a'])], ['time', new Set(['-o', '-f'])], ['nohup', new Set()],
  ['sudo', new Set(['-u', '-g', '-C', '-h', '-p', '-U'])],
]);
/** Shell words that precede a command without being one. */
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!']);

interface Reference extends WiringReceipt {
  reference: string;
  /** A bare name a JavaScript runner resolves (`node build` → `build.js`). */
  resolvesLikeNode?: boolean;
}

/** Collects references and boundaries, deduplicating and capping both per config file. */
class Collector {
  readonly references: Reference[] = [];
  readonly boundaries: WiringBoundary[] = [];
  /** Boundaries dropped by the per-config cap. */
  droppedBoundaries = 0;
  private referencesPerConfig = new Map<string, number>();
  private boundariesPerConfig = new Map<string, number>();
  private seenReferences = new Set<string>();
  private seenBoundaries = new Set<string>();

  reference(ref: Reference): void {
    const key = JSON.stringify([ref.config, ref.key, ref.reference, ref.resolvesLikeNode === true]);
    if (this.seenReferences.has(key)) return;
    this.seenReferences.add(key);
    const count = (this.referencesPerConfig.get(ref.config) ?? 0) + 1;
    this.referencesPerConfig.set(ref.config, count);
    if (count <= MAX_REFERENCES_PER_CONFIG) this.references.push(ref);
    else if (count === MAX_REFERENCES_PER_CONFIG + 1) {
      this.boundary({ config: ref.config, key: '', reference: `more than ${MAX_REFERENCES_PER_CONFIG} references`, reason: 'unsupported-form' });
    }
  }

  boundary(boundary: WiringBoundary): void {
    const key = JSON.stringify([boundary.config, boundary.key, boundary.reference, boundary.reason]);
    if (this.seenBoundaries.has(key)) return;
    this.seenBoundaries.add(key);
    const count = (this.boundariesPerConfig.get(boundary.config) ?? 0) + 1;
    this.boundariesPerConfig.set(boundary.config, count);
    if (count <= MAX_BOUNDARIES_PER_CONFIG) this.boundaries.push(boundary);
    else this.droppedBoundaries++;
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
  const resolutions = new Map<string, Promise<string | { reason: WiringBoundaryReason }>>();
  const directories = new Map<string, Promise<string[] | null>>();
  for (const ref of out.references) {
    const memoKey = `${ref.resolvesLikeNode ? 'node:' : ''}${ref.reference}`;
    let pending = resolutions.get(memoKey);
    if (!pending) {
      pending = resolveReference(root, ref.reference, tsconfig.outDir, tsconfig.rootDir, directories, ref.resolvesLikeNode === true);
      resolutions.set(memoKey, pending);
    }
    const resolved = await pending;
    if (typeof resolved === 'string') {
      const receipts = receiptsByFile.get(resolved) ?? [];
      if (!receipts.some(r => r.config === ref.config && r.key === ref.key)) receipts.push({ config: ref.config, key: ref.key });
      receiptsByFile.set(resolved, receipts);
    } else {
      out.boundary({ config: ref.config, key: ref.key, reference: ref.reference, reason: resolved.reason });
    }
  }

  const wired = [...receiptsByFile]
    .map(([file, receipts]) => ({ file, receipts: receipts.sort(compareReceipts) }))
    .sort((a, b) => compareText(a.file, b.file));
  const boundaries = out.boundaries
    .sort((a, b) => compareReceipts(a, b) || compareText(a.reference, b.reference) || compareText(a.reason, b.reason));
  return {
    wired,
    boundaries: boundaries.slice(0, MAX_REPORTED_BOUNDARIES),
    boundariesOmitted: Math.max(0, boundaries.length - MAX_REPORTED_BOUNDARIES) + out.droppedBoundaries,
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
  nesting = 0,
): void {
  // A `cd` holds for the rest of its subshell: remember the shallowest depth a `cd` ran at.
  let cdDepth = Infinity;
  for (const { words: segment, depth } of shellSegments(command)) {
    if (depth < cdDepth) cdDepth = Infinity;
    const changedDirectory = cdDepth <= depth;
    const executed = executedWords(segment);
    for (const item of executed) {
      const text = item.word.text;
      if (item.kind === 'inline') {
        if (changedDirectory || nesting >= 3) {
          out.boundary({ config, key, reference: text.slice(0, 120), reason: 'unsupported-form' });
        } else {
          commandReferences(text, config, key, workingDirectory, out, nesting + 1);
        }
        continue;
      }
      if (text.includes('$') || text.includes(GHA_EXPR)) {
        out.boundary({ config, key, reference: text.replaceAll(GHA_EXPR, '${{ }}'), reason: 'dynamic-reference' });
      } else if (item.kind === 'cd') {
        cdDepth = Math.min(cdDepth, depth);
      } else if (item.kind === 'module') {
        out.boundary({ config, key, reference: text, reason: 'unsupported-form' });
      } else if (/[*?[\]{}]/.test(text) && !item.word.quoted) {
        out.boundary({ config, key, reference: text, reason: 'dynamic-reference' });
      } else {
        const path = text.replaceAll('\\', '/');
        if (changedDirectory && !path.startsWith('/')) {
          out.boundary({ config, key, reference: path, reason: 'unsupported-form' });
        } else {
          out.reference({
            config, key, reference: workingDirectory ? posix.join(workingDirectory, path) : path,
            ...(item.resolvesLikeNode ? { resolvesLikeNode: true } : {}),
          });
        }
      }
    }
  }
}

type Executed = { kind: 'file' | 'module' | 'cd' | 'inline'; word: Word; resolvesLikeNode?: boolean };

/** The command a word names: the basename of an absolute system path (`/usr/bin/env` → `env`). */
function systemCommandName(text: string): string {
  return text.startsWith('/') ? posix.basename(text) : text;
}

/** The words in one simple command that name something it executes. */
function executedWords(words: Word[]): Executed[] {
  let i = 0;
  while (i < words.length) {
    const text = words[i].text;
    const name = systemCommandName(text);
    if (SHELL_KEYWORDS.has(text) && !words[i].quoted) { i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) && !words[i].quoted) { i++; continue; }
    const wrapperValueFlags = WRAPPERS.get(name);
    if (wrapperValueFlags) {
      i++;
      while (i < words.length && words[i].text.startsWith('-')) {
        i += wrapperValueFlags.has(words[i].text) ? 2 : 1;
      }
      continue;
    }
    if (['pnpm', 'yarn', 'npm'].includes(text) && ['exec', 'dlx'].includes(words[i + 1]?.text ?? '')) { i += 2; continue; }
    if (['pnpm', 'yarn'].includes(text) && RUNNERS.has(words[i + 1]?.text ?? '')) { i++; continue; }
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
  // A relative path in command position runs that repository file; an absolute one is a system binary,
  // and one under node_modules is an installed tool.
  if (!command.text.startsWith('/') && /[/\\]/.test(command.text) && /[\w.]/.test(command.text)) {
    return /^(\.\/)?node_modules[/\\]/.test(command.text) ? [] : [{ kind: 'file', word: command }];
  }
  const syntax = RUNNERS.get(name);
  if (!syntax) return [];

  const executed: Executed[] = [];
  // A shell's `-c` code is the first word that is not an option, after all of them (`bash -co pipefail 'cmd'`).
  let wantsShellCode = false;
  for (let j = i + 1; j < words.length; j++) {
    const word = words[j];
    if (word.text === '-' && !word.quoted) return executed;  // the script is read from stdin
    const isFlag = word.text.startsWith('-') && !word.quoted;
    const [flag, inline] = isFlag ? word.text.split(/=(.*)/s, 2) : [word.text, undefined];
    // A group of short flags (`-euo pipefail`, `-ec`): its letters are flags, and the group takes a value
    // when its last letter does.
    if (isFlag && /^-[A-Za-z]{2,}$/.test(flag) && inline === undefined) {
      const letters = flag.slice(1);
      // A shell takes every value its group letters need from the following words, in order
      // (`bash -oe pipefail x.sh`, `bash -ce 'cmd'`).
      if (syntax.runsInline) {
        let next = j + 1;
        for (const l of letters) {
          const letter = `-${l}`;
          if (syntax.valueFlags.has(letter)) next++;
          else if (syntax.inlineFlags.has(letter)) wantsShellCode = true;
        }
        j = next - 1;
        continue;
      }
      // Other runners read the group as getopt does: letters are switches until one takes a value, which
      // is the rest of the group, or the next word when it is the last letter.
      let group: Executed[] | 'continue' = 'continue';
      for (let k = 0; k < letters.length; k++) {
        const letter = `-${letters[k]}`;
        const rest = letters.slice(k + 1);
        if (syntax.inlineFlags.has(letter)) {
          const code = rest || words[j + 1]?.text;
          if (syntax.runsInline && code) executed.push({ kind: 'inline', word: { text: code, quoted: true } });
          group = executed;
          break;
        }
        if (syntax.moduleFlag === letter) {
          const module = rest || words[j + 1]?.text;
          if (module) executed.push({ kind: 'module', word: { text: `${letter} ${module}`, quoted: false } });
          group = executed;
          break;
        }
        if (syntax.valueFlags.has(letter)) {
          if (!rest) j++;
          break;
        }
      }
      if (group !== 'continue') return group;
      continue;
    }
    if (syntax.runsInline && syntax.inlineFlags.has(flag) && inline === undefined) {
      wantsShellCode = true;
      continue;
    }
    if (syntax.inlineFlags.has(flag)) {
      const code = inline ?? words[j + 1]?.text;
      if (syntax.runsInline && code) executed.push({ kind: 'inline', word: { text: code, quoted: true } });
      return executed;
    }
    if (syntax.moduleFlag && flag === syntax.moduleFlag) {
      const module = inline ?? words[j + 1]?.text;
      if (module) executed.push({ kind: 'module', word: { text: `${flag} ${module}`, quoted: false } });
      return executed;
    }
    if (isFlag && syntax.preloadFlags?.has(flag)) {
      const value = inline !== undefined ? { text: inline, quoted: word.quoted } : words[++j];
      // A preload named as a package (`--import tsx`, `-r dotenv/config`) is not a repository file.
      if (value && /^\.{0,2}\/|\.[cm]?[jt]sx?$/.test(value.text)) executed.push({ kind: 'file', word: value });
      continue;
    }
    if (isFlag && syntax.valueFlags.has(flag) && inline === undefined) { j++; continue; }
    // An unknown flag is taken as a switch: the next word is still considered as the script.
    if (isFlag) continue;
    if (wantsShellCode) {
      executed.push({ kind: 'inline', word: { text: word.text, quoted: true } });
      return executed;
    }
    if (j === i + 1 && syntax.toolSubcommands?.has(word.text)) return executed;
    if (j === i + 1 && syntax.subcommands?.has(word.text)) continue;
    // After `bun run` / `deno run`, a bare name is a package script, not a file.
    if (!looksLikeScript(word.text) && syntax.subcommands?.has(words[i + 1]?.text ?? '')) return executed;
    // A bare name (`node build`, `bash test`) is tried as a file; resolution discloses a miss.
    executed.push({ kind: 'file', word, resolvesLikeNode: NODE_RESOLVING.has(name) });
    return executed;
  }
  return executed;
}

/** A word that can name a script file: a path, or a name with a script extension. */
function looksLikeScript(text: string): boolean {
  return /[/\\]/.test(text) || /\.[A-Za-z0-9]{1,5}$/.test(text);
}

/**
 * A command line as simple commands of words: split on `&&`, `||`, `;`, `|`, `&`, and newlines,
 * honoring quotes; `#` comments, redirect targets, and heredoc bodies are dropped.
 */
function shellSegments(command: string): Array<{ words: Word[]; depth: number }> {
  const segments: Array<{ words: Word[]; depth: number }> = [];
  let depth = 0;
  const parens: Array<'word' | 'subshell'> = [];
  let words: Word[] = [];
  let word = '';
  let quoted = false;
  let inWord = false;
  let redirect = false;
  const heredocs: string[] = [];

  const endWord = () => {
    if (inWord) {
      if (redirect) redirect = false;
      else if ((word === '{' || word === '}') && !quoted) {
        // A brace group's words are a command of their own.
        word = ''; quoted = false; inWord = false;
        if (words.length > 0) segments.push({ words, depth });
        words = [];
        return;
      } else words.push({ text: word, quoted });
    }
    word = ''; quoted = false; inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push({ words, depth });
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
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close < 0 ? command.length : close;
      word += command.slice(i + 1, end);
      quoted = true; inWord = true;
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        // Inside double quotes a backslash escapes only `$`, backtick, `"`, `\`, and newline.
        if (command[j] === '\\' && j + 1 < command.length && '$`"\\\n'.includes(command[j + 1])) { word += command[j + 1]; j += 2; continue; }
        word += command[j++];
      }
      quoted = true; inWord = true;
      i = j;
      continue;
    }
    if (ch === '#' && !inWord) {
      const end = command.indexOf('\n', i);
      i = (end < 0 ? command.length : end) - 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    if (ch === '(' || ch === ')') {
      // `$(`, `$((`, `<(`, and `@(` open substitutions or patterns, not subshells: their `)` must not
      // close a subshell. A plain `(` opens a subshell whose commands are segments of their own.
      const previous = i > 0 ? command[i - 1] : '';
      // `$((` arithmetic and extglob patterns (`@(`, `?(`, …) are part of a word.
      if (ch === '(' && ((previous === '$' && command[i + 1] === '(') || (inWord && previous !== '$'))) {
        parens.push('word');
        word += ch; inWord = true;
        continue;
      }
      // `$(`, `<(`, and `>(` run their commands in a subshell: segments of their own, and a `cd` inside
      // ends with them.
      if (ch === '(' && '$<>'.includes(previous) && previous !== '') {
        // The `$` stays in the word it interrupts, so an argument built from a substitution
        // (`node dist/$(cat f).js`) still reads as dynamic.
        if (previous !== '$') redirect = false;
        endSegment();
        parens.push('subshell');
        depth++;
        continue;
      }
      if (ch === ')' && parens.length > 0 && parens[parens.length - 1] === 'word') {
        parens.pop();
        word += ch; inWord = true;
        continue;
      }
      endSegment();
      if (ch === '(') {
        parens.push('subshell');
        depth++;
      } else {
        parens.pop();
        depth = Math.max(0, depth - 1);
        // An empty segment marks the close, so a `cd` inside does not reach a sibling subshell.
        segments.push({ words: [], depth });
      }
      continue;
    }
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
    // Keys are matched where string contents are blanked, so a key inside a string is not a key.
    const keysOnly = blankStringValues(code);
    for (const key of TEST_RUNNER_KEYS) {
      let matches = 0;
      for (const match of keysOnly.matchAll(new RegExp(`(?:\\b|['"])${key}['"]?\\s*:\\s*`, 'g'))) {
        if (++matches > MAX_KEY_MATCHES_PER_CONFIG) {
          out.boundary({ config, key, reference: `more than ${MAX_KEY_MATCHES_PER_CONFIG} ${key} entries`, reason: 'unsupported-form' });
          break;
        }
        const value = readValueExpression(code, match.index + match[0].length);
        // A type annotation (`setupFiles: string[]`) declares the key; it wires nothing.
        if (/^(?:string|readonly\s+string)(?:\[\])?\s*[;,]?\s*$|^Array<string>/.test(value.trim())) continue;
        const literals = literalStrings(value);
        if (literals === null) {
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
  const limit = Math.min(code.length, start + 20_000);
  for (let i = start; i < limit; i++) {
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const close = closingQuote(code, i);
      if (close < 0) return code.slice(start, limit);
      i = close;
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
  return code.slice(start, limit);
}

/**
 * The string literals of a string or array-of-strings expression, scanned in one pass; `null` when the
 * expression is anything else (an identifier, a call, a spread, a template substitution, an unclosed
 * string).
 */
function literalStrings(value: string): string[] | null {
  const literals: string[] = [];
  const text = value.trim();
  let i = text.startsWith('[') ? 1 : 0;
  const end = text.startsWith('[') ? (text.endsWith(']') ? text.length - 1 : -1) : text.length;
  if (end < 0) return null;
  while (i < end) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i++; continue; }
    if (ch !== "'" && ch !== '"' && ch !== '`') return null;
    const close = closingQuote(text, i);
    if (close < 0 || close >= end) return null;
    const content = text.slice(i + 1, close);
    if (ch === '`' && content.includes('${')) return null;
    literals.push(content);
    i = close + 1;
  }
  return literals;
}

/** Code with the contents of every string blanked, except a string used as an object key. */
function blankStringValues(code: string): string {
  let out = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const regexEnd = regexLiteralEnd(code, i);
    if (regexEnd > 0) {
      out += ' '.repeat(regexEnd - i);
      i = regexEnd - 1;
      continue;
    }
    if (ch !== "'" && ch !== '"' && ch !== '`') { out += ch; continue; }
    const close = closingQuote(code, i);
    const end = close < 0 ? code.length - 1 : close;
    // A key string follows `{` or `,` and precedes `:` (a ternary's `? 'x' : 'y'` is not a key).
    const isKey = /^\s*:/.test(code.slice(end + 1, end + 64)) && /[{,]\s*$/.test(code.slice(Math.max(0, i - 64), i));
    out += isKey ? code.slice(i, end + 1) : ch + ' '.repeat(Math.max(0, end - i - 1)) + (close < 0 ? '' : ch);
    i = end;
  }
  return out;
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
          out.boundary({ config, key, reference: `shell ${shell.split(/\s/)[0].replaceAll(GHA_EXPR, '${{ }}')}`, reason: 'unsupported-form' });
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
  directories: Map<string, Promise<string[] | null>>,
  resolvesLikeNode = false,
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
    for (const candidate of sourceVariants(base, resolvesLikeNode)) {
      const absolute = join(root, candidate);
      if (!isConfinedPath(root, absolute)) { outside = true; continue; }
      try {
        if ((await stat(absolute)).isFile()) return await repositorySpelling(root, candidate, directories);
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
async function repositorySpelling(
  root: string,
  candidate: string,
  directories: Map<string, Promise<string[] | null>>,
): Promise<string> {
  const spelled: string[] = [];
  for (const part of candidate.split('/')) {
    const dir = join(root, ...spelled);
    let pending = directories.get(dir);
    if (!pending) {
      pending = readdir(dir).catch(() => null);
      directories.set(dir, pending);
    }
    const entries = await pending;
    spelled.push(!entries || entries.includes(part) ? part : entries.find(e => e.toLowerCase() === part.toLowerCase()) ?? part);
  }
  return spelled.join('/');
}

/** The path itself, then the TypeScript sources a JavaScript build output is compiled from. */
function sourceVariants(path: string, resolvesLikeNode = false): string[] {
  const swap = (from: RegExp, to: string[]) => from.test(path) ? to.map(ext => path.replace(from, ext)) : [];
  // An extensionless name a JavaScript runner runs is tried as that runner resolves it (`node build` →
  // `build.js`); a shell or Python runs exactly the file named.
  const extensionless = !resolvesLikeNode || /\.[A-Za-z0-9]{1,5}$/.test(posix.basename(path))
    ? []
    : ['.js', '.mjs', '.cjs', '.ts', '/index.js', '/index.ts'].map(ext => path + ext);
  return [
    ...swap(/\.js$/, ['.ts', '.tsx']),
    ...swap(/\.jsx$/, ['.tsx']),
    ...swap(/\.mjs$/, ['.mts']),
    ...swap(/\.cjs$/, ['.cts']),
    path,
    ...extensionless,
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
  return read.bytes.toString('utf-8').replace(/^\uFEFF/, '');
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

/** Characters scanned for the end of a regex literal before deciding it is not one. */
const MAX_REGEX_LITERAL = 512;
/** Template substitutions nested deeper than this are treated as unclosed. */
const MAX_TEMPLATE_NESTING = 64;

/**
 * The index of the closing quote of the string opening at `start`, or -1 when it is unclosed. Template
 * substitutions (`${ … }`) may hold their own strings; they are tracked on an explicit stack.
 */
function closingQuote(source: string, start: number): number {
  // Each frame is the quote of an open string, or `}` for an open substitution (with its brace depth).
  const frames: Array<{ quote: string; braces: number }> = [{ quote: source[start], braces: 0 }];
  for (let i = start + 1; i < source.length; i++) {
    const frame = frames[frames.length - 1];
    const ch = source[i];
    if (frame.quote === '}') {
      if (ch === "'" || ch === '"' || ch === '`') {
        if (frames.length >= MAX_TEMPLATE_NESTING) return -1;
        frames.push({ quote: ch, braces: 0 });
      } else if (ch === '{') frame.braces++;
      else if (ch === '}') {
        if (frame.braces === 0) frames.pop();
        else frame.braces--;
      }
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (frame.quote === '`' && ch === '$' && source[i + 1] === '{') {
      if (frames.length >= MAX_TEMPLATE_NESTING) return -1;
      frames.push({ quote: '}', braces: 0 });
      i++;
      continue;
    }
    if (ch === frame.quote) {
      frames.pop();
      if (frames.length === 0) return i;
    }
  }
  return -1;
}

/** The index just past a regex literal opening at `start`, or -1 when `start` does not open one. */
function regexLiteralEnd(source: string, start: number): number {
  if (source[start] !== '/' || source[start + 1] === '/' || source[start + 1] === '*') return -1;
  let k = start - 1;
  while (k >= 0 && (source[k] === ' ' || source[k] === '\t')) k--;
  const afterKeyword = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw)$/.test(source.slice(Math.max(0, k - 8), k + 1));
  if (k < 0 || !('(,=:[!&|?{};'.includes(source[k]) || afterKeyword)) return -1;
  let inClass = false;
  // A regex literal is short; a scan that finds no end within the line (or this bound) is not one.
  const limit = Math.min(source.length, start + MAX_REGEX_LITERAL);
  for (let i = start + 1; i < limit && source[i] !== '\n'; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '[') inClass = true;
    else if (source[i] === ']') inClass = false;
    else if (source[i] === '/' && !inClass) return i + 1;
  }
  return -1;
}

/** The index of the closing quote of the string opening at `start`, or the last index. */
function skipString(source: string, start: number): number {
  const close = closingQuote(source, start);
  return close < 0 ? source.length - 1 : close;
}

/** Source with `//` and `/* *\/` comments removed; string and template contents are untouched. */
function stripCodeComments(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const regexEnd = regexLiteralEnd(source, i);
    if (regexEnd > 0) {
      out += source.slice(i, regexEnd);
      i = regexEnd - 1;
      continue;
    }
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
