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

/**
 * Test runners in command position (a closed list). A command is split into segments at `;`, `&&`,
 * `||`, `|`, `(` and newlines; each segment loses leading `VAR=value` assignments and wrappers
 * (`npx`, `time`, `pnpm exec`, …) before its first word is compared. So `cat jest.config.js`,
 * `git commit -m "fix vitest"`, and `pip install pytest` are not runs.
 */
const RUNNER_HEAD = /^(?:vitest|jest|mocha|ava|pytest|py\.test|tox|nox|rspec|phpunit|pest|ctest|tap)(?=\s|$)|^(?:playwright\s+test|cypress\s+run|deno\s+test|bun\s+test|node\s+--test|dotnet\s+test|go\s+test|cargo\s+(?:test|nextest)|mix\s+test|swift\s+test|bazel\s+test|nx\s+(?:run\s+\S+:)?test|turbo\s+(?:run\s+)?test|python3?\s+-m\s+(?:pytest|unittest)|python3?\s+manage\.py\s+test)(?=\s|$)|^(?:\.\/)?(?:mvnw?|gradlew?)(?:\s+\S+)*\s+(?:test|verify|check)(?=\s|$)/;
const PM_HEAD = /^(?:npm|pnpm|yarn|bun)(?:\.cmd)?(?:\s+--?\S+(?:\s+\S+)?)*?\s+(?:run\s+)?(?:test|t)(?=\s|$|:)/;
const MAKE_HEAD = /^make(?:\s+-\S+(?:\s+\S+)?)*\s+(?:test|check)[\w-]*(?=\s|$)/;
const NOT_A_RUN = /\s--(?:version|help|listTests|list-tests|collect-only|co)(?=\s|$)|\s-h(?=\s|$)/;
const WRAPPER = /^(?:(?:\w+=\S*\s+)+|(?:sudo|time|env|nice|command|exec)\s+|(?:npx|bunx)\s+(?:--?\S+\s+)*|pnpm\s+(?:exec|dlx)\s+|yarn\s+(?:dlx\s+)?(?=[a-z])(?!(?:test|run|t)\b)|(?:\.\/)?node_modules\/\.bin\/)/;

/** The command segments, each with its leading assignments and wrappers removed. */
function segments(command: string): string[] {
  return command.split(/;|&&|\|\||\||\(|\n/).map(seg => {
    let s = seg.trim();
    for (let i = 0; i < 6; i++) { const next = s.replace(WRAPPER, ''); if (next === s) break; s = next.trim(); }
    return s;
  }).filter(Boolean);
}

export interface TestRun { at: number; command: string; exit?: number; interrupted?: boolean }

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
  return new RegExp(`^(?:npm(?:\\.cmd)?\\s+run|pnpm(?:\\s+run)?|yarn(?:\\s+run)?|bun\\s+run)\\s+(?:${alt})(?=\\s|$)`);
}

/** Whether a shell command is a test run. */
export function isTestCommand(root: string, command: string): boolean {
  const declared = declaredTestCommands(root);
  return segments(command.slice(0, 4000)).some(seg =>
    !NOT_A_RUN.test(` ${seg}`) && (RUNNER_HEAD.test(seg) || PM_HEAD.test(seg) || MAKE_HEAD.test(seg) || (declared?.test(seg) ?? false)));
}

/** A command as stored and shown: assignments dropped, secrets redacted, control text removed. */
async function storedCommand(command: string): Promise<string> {
  const { emittedText } = await import('./generated-file-guard.js');
  const bare = command.replace(/(?:^|(?<=[;&|(]\s*))(?:\w+=\S*\s+)+/g, '').replace(/\s+/g, ' ').trim();
  return emittedText(bare).slice(0, 160);
}

/** Symbol hashes of the given files now. */
async function hashFiles(root: string, files: readonly string[], budgetMs = 12_000): Promise<RunState['atLastRun']> {
  const { defaultHasher } = await import('./session-ledger.js');
  const out: RunState['atLastRun'] = {};
  const deadline = Date.now() + budgetMs;
  for (const f of files) {
    // Past the budget a file is left out: it then reads as "not determined", never as unchanged.
    if (Date.now() > deadline) break;
    let text: string;
    try { text = await readFileConfined(root, f, MAX_FILE_BYTES); } catch { out[f] = {}; continue; } // deleted or unreadable: no symbols
    const hashes = await defaultHasher(f, text).catch(() => undefined);
    out[f] = Object.fromEntries([...(hashes ?? new Map())].map(([id, v]) => [id, { name: v.name, hash: v.hash }]));
  }
  return out;
}

/**
 * After-tools, for a shell command: count it, and record it when it is a test run. An interrupted
 * run is recorded as interrupted and does not move the "last run" the stop fact compares with.
 */
export async function recordShellCommand(root: string, sessionId: string, command: string, exit?: number, interrupted = false): Promise<boolean> {
  const test = isTestCommand(root, command);
  const state = readRunState(root, sessionId);
  const snapshot = test && !interrupted ? await hashFiles(root, state.editedFiles) : undefined;
  const stored = test ? await storedCommand(command) : '';
  await writeRunState(root, sessionId, s => ({
    ...s,
    shellSeen: s.shellSeen + 1,
    ...(test ? {
      runs: [...s.runs, { at: Date.now(), command: stored, ...(exit !== undefined ? { exit } : {}), ...(interrupted ? { interrupted: true } : {}) }],
      // A file another hook recorded while this one was hashing keeps its own record.
      ...(snapshot ? { atLastRun: { ...Object.fromEntries(Object.entries(s.atLastRun).filter(([f]) => !(f in snapshot) && !state.editedFiles.includes(f))), ...snapshot } } : {}),
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
  // A file edited again moves to the end, so the oldest-edited file is the one dropped at the cap.
  await writeRunState(root, sessionId, s => ({ ...s, editedFiles: [...s.editedFiles.filter(f => !files.includes(f)), ...files] }));
}

export interface EditsAfterRun {
  kind: 'not-observed' | 'no-run' | 'after-run' | 'clean';
  lastRun?: TestRun;
  /** Symbols edited after the last run (kind `after-run`); `removed` when the symbol is gone. */
  symbols?: Array<{ name: string; file: string; removed?: boolean }>;
  /** Files edited after the last run whose symbols at the run were not recorded. */
  undetermined?: string[];
  /** Files edited this session (kind `no-run`). */
  files?: string[];
  /** Test runs after the last completed one that were interrupted. */
  interruptedSince?: number;
}

/** At stop: what was edited after the last observed, completed test run. */
export async function editsAfterLastRun(root: string, sessionId: string): Promise<EditsAfterRun | undefined> {
  const s = readRunState(root, sessionId);
  if (!s.editedFiles.length) return undefined;
  if (!s.shellSeen) return { kind: 'not-observed' };
  const completed = s.runs.filter(r => !r.interrupted);
  const lastRun = completed[completed.length - 1];
  const interruptedSince = s.runs.filter(r => r.interrupted && (!lastRun || r.at > lastRun.at)).length;
  if (!lastRun) return { kind: 'no-run', files: s.editedFiles, ...(interruptedSince ? { interruptedSince } : {}) };
  const now = await hashFiles(root, s.editedFiles);
  const symbols: NonNullable<EditsAfterRun['symbols']> = [];
  const undetermined: string[] = [];
  for (const f of s.editedFiles) {
    const then = s.atLastRun[f];
    const current = now[f];
    if (!then || !current) {
      // No record of this file at the run (before-edit off or timed out), or not hashed now: which
      // symbols changed is not determined. Unchanged since the run only when both sides agree.
      if (!then || current === undefined) { undetermined.push(f); }
      continue;
    }
    for (const [id, v] of Object.entries(current)) if (then[id]?.hash !== v.hash) symbols.push({ name: v.name, file: f });
    for (const [id, v] of Object.entries(then)) if (!(id in current)) symbols.push({ name: v.name, file: f, removed: true });
  }
  const extra = { ...(undetermined.length ? { undetermined } : {}), ...(interruptedSince ? { interruptedSince } : {}) };
  return symbols.length || undetermined.length ? { kind: 'after-run', lastRun, symbols, ...extra } : { kind: 'clean', lastRun, ...extra };
}
