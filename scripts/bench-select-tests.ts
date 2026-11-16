/**
 * bench-select-tests.ts — does `select_tests` name the tests real changes had to touch?
 *
 * For each recent commit on the base branch that changed production code under `src/` and modified
 * an existing test file: check out the commit's parent in a scratch worktree, build the index there,
 * apply only the commit's production changes, and ask `select_tests` (diff vs HEAD) which tests to
 * run. Ground truth is the test files the commit modified (see src/bench/select-tests-replay.ts for
 * why that is a proxy). Deterministic, local, no LLM. Prints recall and how many test files each
 * selection names.
 *
 * Run (after `npm run build`; each commit builds an index, about 20 s here):
 *   npm run bench:select-tests                     # the last 20 scorable commits of origin/main
 *   npm run bench:select-tests -- --commits 40 --base origin/main --json
 *   npm run bench:select-tests -- --commit <sha>    # one commit
 *
 * Manual benchmark, not part of CI.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { replayCase, scoreReplay, summarize, type ReplayCase, type ReplayScore } from '../src/bench/select-tests-replay.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const arg = (flag: string): string | undefined => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const json = process.argv.includes('--json');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (!existsSync(CLI)) { console.error('Build first: npm run build'); process.exit(1); }

const base = arg('--base') ?? 'origin/main';
const want = Number(arg('--commits') ?? 20);
const only = arg('--commit');

const cases: ReplayCase[] = [];
const candidates = only ? [only] : git(ROOT, 'rev-list', '--first-parent', '--max-count', String(want * 6), base).trim().split('\n');
for (const sha of candidates) {
  if (cases.length >= (only ? 1 : want)) break;
  const c = replayCase(sha, git(ROOT, 'log', '-1', '--format=%s', sha).trim(), git(ROOT, 'diff', '--name-status', '-M', `${sha}^`, sha));
  if (c) cases.push(c);
}
if (cases.length === 0) { console.error('No scorable commit found.'); process.exit(1); }

const work = mkdtempSync(join(tmpdir(), 'ol-bench-select-'));
const tree = join(work, 'tree');
const home = join(work, 'home');
mkdirSync(home);
git(ROOT, 'worktree', 'add', '--detach', '--quiet', tree, `${cases[0].commit}^`);
const { handleSelectTests } = await import(pathToFileURL(join(ROOT, 'dist', 'core', 'services', 'mcp-handlers', 'test-impact.js')).href) as {
  handleSelectTests: (input: { directory: string; diffRef: string }) => Promise<{ selectedTests?: Array<{ file: string; confidence: string }>; error?: string }>;
};
const { withLoggerOptions } = await import(pathToFileURL(join(ROOT, 'dist', 'utils', 'logger.js')).href) as {
  withLoggerOptions: <T>(options: { quiet: boolean }, fn: () => Promise<T>) => Promise<T>;
};

const scores: ReplayScore[] = [];
try {
  for (const c of cases) {
    git(tree, 'checkout', '--quiet', '--force', '--detach', `${c.commit}^`);
    git(tree, 'clean', '-qfdx', '-e', '.openlore', '-e', 'node_modules');
    mkdirSync(join(tree, '.openlore'), { recursive: true });
    if (existsSync(join(ROOT, '.openlore', 'config.json'))) cpSync(join(ROOT, '.openlore', 'config.json'), join(tree, '.openlore', 'config.json'));
    if (!existsSync(join(tree, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(tree, 'node_modules'));
    const env = { ...process.env, HOME: home, OPENLORE_NO_AUTO_ANALYZE: '1' };
    const analyzed = spawnSync(process.execPath, [CLI, 'analyze'], { cwd: tree, env, encoding: 'utf8' });
    if (analyzed.status !== 0) { console.error(`${c.commit.slice(0, 9)}: analyze failed; skipped`); continue; }
    git(tree, 'checkout', c.commit, '--', ...c.applied);
    const r = await withLoggerOptions({ quiet: true }, () => handleSelectTests({ directory: tree, diffRef: 'HEAD' }));
    if (r.error) { console.error(`${c.commit.slice(0, 9)}: ${r.error}; skipped`); continue; }
    const s = scoreReplay(c, r.selectedTests ?? []);
    scores.push(s);
    if (!json) console.log(`${s.commit.slice(0, 9)} ${s.hits}/${s.truth} found, ${s.selectedFiles} files selected  ${s.subject.slice(0, 70)}${s.misses.length ? `\n    missed: ${s.misses.join(', ')}` : ''}`);
  }
} finally {
  git(ROOT, 'worktree', 'remove', '--force', tree);
  rmSync(work, { recursive: true, force: true });
}

const summary = summarize(scores);
if (json) console.log(JSON.stringify({ summary, scores }, null, 2));
else {
  console.log(`\n${summary.cases} commits: ${summary.hits}/${summary.truth} modified tests selected (recall ${(summary.recall * 100).toFixed(0)}%), ${summary.meanSelectedFiles} test files selected on average`);
  for (const [tier, t] of Object.entries(summary.tiers ?? {})) {
    console.log(`  running only ${tier}${tier === 'high' ? '' : ' and above'}: recall ${(t.recall * 100).toFixed(0)}%, ${t.meanFiles} files on average`);
  }
}
