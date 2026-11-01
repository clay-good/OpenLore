/**
 * Test runs the agent made, and the symbols it edited after the last one
 * (change: add-session-ledger-runs-contracts-tokens, first requirement).
 *
 * The after-tools hook sees each shell command the harness ran. A command that is a test run — a
 * runner from a closed list, or a test script the repository declares in `package.json` or a
 * Makefile — is recorded with its time and exit status (when the payload carries one), together
 * with the content hash of every symbol in the files this session edited. At stop, the symbols whose
 * hash changed since that run (or that are new) are named, with the tests that reach them.
 *
 * OpenLore runs no test. When no shell command ever reached the hook, test runs are not observed and
 * the fact is withheld with that reason, never stated as "nothing ran". One small JSON record per
 * harness session, beside the other hook records; writes merge with a concurrent hook's.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { readFileConfined } from '../../utils/path-confinement.js';

const MAX_FILES = 200;
const MAX_RUNS = 50;
const MAX_FILE_BYTES = 1024 * 1024;

/** Test runners, by name (a closed list); `npm test` and its siblings; `make test`/`make check`. */
const RUNNER = /(?:^|[\s;&|(`])(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn(?:\s+dlx)?)\s+)?(?:vitest|jest|mocha|ava|playwright\s+test|cypress\s+run|pytest|py\.test|tox|nox|rspec|phpunit|pest|ctest|deno\s+test|bun\s+test|node\s+--test|dotnet\s+test|go\s+test|cargo\s+(?:test|nextest)|mix\s+test|swift\s+test|bazel\s+test|(?:\.\/)?(?:mvnw?|gradlew?)\b[^;&|]*\b(?:test|verify|check)\b|python3?\s+-m\s+(?:pytest|unittest))\b/;
const PM_TEST = /(?:^|[\s;&|(`])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)(?=$|[\s;&|)`:])/;
const MAKE_TEST = /(?:^|[\s;&|(`])make\s+(?:-\S+\s+)*(?:test|check)\w*/;

export interface TestRun { at: number; command: string; exit?: number }

interface RunState {
  /** Shell commands seen by the after-tools hook this session (0 ⇒ test runs are not observed). */
  shellSeen: number;
  /** Files this session edited (root-relative). */
  editedFiles: string[];
  runs: TestRun[];
  /** At the last run: file → symbol id → { name, hash }. */
  atLastRun: Record<string, Record<string, { name: string; hash: string }>>;
}

const empty = (): RunState => ({ shellSeen: 0, editedFiles: [], runs: [], atLastRun: {} });

function statePath(root: string, sessionId: string): string {
  const id = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return join(root, OPENLORE_DIR, 'session-ledger', 'test-runs', `${id}.json`);
}

export function readRunState(root: string, sessionId: string): RunState {
  try {
    const v = JSON.parse(readFileSync(statePath(root, sessionId), 'utf-8')) as Partial<RunState>;
    return {
      shellSeen: typeof v.shellSeen === 'number' ? v.shellSeen : 0,
      editedFiles: Array.isArray(v.editedFiles) ? v.editedFiles.filter((f): f is string => typeof f === 'string') : [],
      runs: Array.isArray(v.runs) ? v.runs.filter(r => r && typeof r.at === 'number' && typeof r.command === 'string') : [],
      atLastRun: v.atLastRun && typeof v.atLastRun === 'object' ? v.atLastRun : {},
    };
  } catch {
    return empty();
  }
}

/** Write, merged with what a concurrent hook of the same session wrote (the harness runs hooks in parallel). */
async function writeRunState(root: string, sessionId: string, update: (s: RunState) => RunState): Promise<void> {
  try {
    const next = update(readRunState(root, sessionId));
    next.editedFiles = [...new Set(next.editedFiles)].slice(-MAX_FILES);
    next.runs = next.runs.sort((a, b) => a.at - b.at).slice(-MAX_RUNS);
    await atomicWriteFile(statePath(root, sessionId), JSON.stringify(next));
  } catch { /* best effort: at worst a run is not recorded */ }
}

/** The test scripts this repository declares, as the commands that run them. */
function declaredTestCommands(root: string): RegExp | undefined {
  const names: string[] = [];
  try {
    const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { scripts?: Record<string, unknown> }).scripts ?? {};
    for (const name of Object.keys(scripts)) if (/^(?:test|e2e|spec)(?:$|[:-])/i.test(name) || /(?:^|:)test$/i.test(name)) names.push(name);
  } catch { /* no package.json */ }
  if (!names.length) return undefined;
  const alt = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?:^|[\\s;&|(\`])(?:npm\\s+run|pnpm(?:\\s+run)?|yarn(?:\\s+run)?|bun\\s+run)\\s+(?:${alt})(?=$|[\\s;&|)\`])`);
}

/** Whether a shell command is a test run. */
export function isTestCommand(root: string, command: string): boolean {
  const c = command.slice(0, 4000);
  return RUNNER.test(c) || PM_TEST.test(c) || MAKE_TEST.test(c) || (declaredTestCommands(root)?.test(c) ?? false);
}

/** Symbol hashes of the given files now. */
async function hashFiles(root: string, files: readonly string[]): Promise<RunState['atLastRun']> {
  const { defaultHasher } = await import('./session-ledger.js');
  const out: RunState['atLastRun'] = {};
  for (const f of files) {
    let text: string;
    try { text = await readFileConfined(root, f, MAX_FILE_BYTES); } catch { out[f] = {}; continue; } // deleted or unreadable: no symbols
    const hashes = await defaultHasher(f, text).catch(() => undefined);
    out[f] = Object.fromEntries([...(hashes ?? new Map())].map(([id, v]) => [id, { name: v.name, hash: v.hash }]));
  }
  return out;
}

/** After-tools, for a shell command: count it, and record it when it is a test run. */
export async function recordShellCommand(root: string, sessionId: string, command: string, exit?: number): Promise<boolean> {
  const test = isTestCommand(root, command);
  const state = readRunState(root, sessionId);
  const snapshot = test ? await hashFiles(root, state.editedFiles) : undefined;
  await writeRunState(root, sessionId, s => ({
    ...s,
    shellSeen: s.shellSeen + 1,
    ...(test ? {
      runs: [...s.runs, { at: Date.now(), command: command.replace(/\s+/g, ' ').trim().slice(0, 160), ...(exit !== undefined ? { exit } : {}) }],
      atLastRun: snapshot!,
    } : {}),
  }));
  return test;
}

/**
 * Before-edit: a file first edited after the last run keeps its pre-edit symbols as the run saw
 * them. After-tools: the edit is recorded.
 */
export async function recordEditIntent(root: string, sessionId: string, files: readonly string[]): Promise<void> {
  const state = readRunState(root, sessionId);
  const fresh = state.runs.length ? files.filter(f => !(f in state.atLastRun)) : [];
  const before = fresh.length ? await hashFiles(root, fresh) : {};
  if (!fresh.length) return;
  await writeRunState(root, sessionId, s => ({ ...s, atLastRun: { ...before, ...s.atLastRun } }));
}

export async function recordEdits(root: string, sessionId: string, files: readonly string[]): Promise<void> {
  if (!files.length) return;
  await writeRunState(root, sessionId, s => ({ ...s, editedFiles: [...s.editedFiles, ...files] }));
}

export interface EditsAfterRun {
  kind: 'not-observed' | 'no-run' | 'after-run' | 'clean';
  lastRun?: TestRun;
  /** Symbols edited after the last run (kind `after-run`). */
  symbols?: Array<{ name: string; file: string }>;
  /** Files edited this session (kind `no-run`). */
  files?: string[];
}

/** At stop: what was edited after the last observed test run. */
export async function editsAfterLastRun(root: string, sessionId: string): Promise<EditsAfterRun | undefined> {
  const s = readRunState(root, sessionId);
  if (!s.editedFiles.length) return undefined;
  if (!s.shellSeen) return { kind: 'not-observed' };
  const lastRun = s.runs[s.runs.length - 1];
  if (!lastRun) return { kind: 'no-run', files: s.editedFiles };
  const now = await hashFiles(root, s.editedFiles);
  const symbols: Array<{ name: string; file: string }> = [];
  for (const f of s.editedFiles) {
    const then = s.atLastRun[f];
    for (const [id, v] of Object.entries(now[f] ?? {})) {
      // A file the run never saw (no before-edit record): every symbol in it counts as after the run.
      if (!then || then[id]?.hash !== v.hash) symbols.push({ name: v.name, file: f });
    }
  }
  return symbols.length ? { kind: 'after-run', lastRun, symbols } : { kind: 'clean', lastRun };
}
