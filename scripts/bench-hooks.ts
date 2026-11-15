/**
 * bench-hooks.ts — hook latency per agent-loop moment (change: hook-reliability, task 1.1).
 *
 * Measures the four moments the hooks deliver evidence at (prompt submitted, before an edit, after
 * an edit or a shell command, before stop) two ways:
 *
 *   in-process  the handler alone (`buildInjection`, `runHook`), after warm-up runs;
 *   spawned     the built CLI as a harness runs it (`node dist/cli/index.js …`), cold each time.
 *
 * It never touches the repository it measures: the generated fixture is written to a temporary
 * folder, and `--repo` is cloned into one. In that copy it builds the index, then makes one edit
 * (a new function appended to the target file), so `before-stop` has a change to report.
 *
 * Run (after `npm run build`):
 *   npm run bench:hooks                                  # the 200-file fixture
 *   npm run bench:hooks -- --repo . --file src/utils/misc.ts
 *   options: --runs <n> (30), --warmup <n> (3), --json
 *
 * Manual benchmark, not part of CI. The asserted budget test is task 5.2.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { fixtureFile, writeHookFixture } from '../src/cli/commands/hook-fixture.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const RUNS = Number(option('runs') ?? 30);
const WARMUP = Number(option('warmup') ?? 3);
const AS_JSON = process.argv.includes('--json');
const REPO = option('repo');

const log = (line: string) => process.stderr.write(`${line}\n`);

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A throwaway copy to measure in, and the file the simulated edits touch. */
function prepare(): { dir: string; file: string; label: string; prompt: string } {
  const dir = mkdtempSync(join(tmpdir(), 'openlore-bench-hooks-'));
  if (REPO) {
    const source = resolve(REPO);
    log(`cloning ${source}`);
    rmSync(dir, { recursive: true, force: true });
    git(tmpdir(), 'clone', '--quiet', '--no-hardlinks', source, dir);
    const file = option('file') ?? git(dir, 'ls-files', '*.ts').split('\n').find(f => f && !f.endsWith('.d.ts'));
    if (!file || !existsSync(join(dir, file))) throw new Error(`no file to edit: ${file ?? '(none)'}`);
    const functions = Number(option('functions') ?? NaN);
    return { dir, file, label: `${source.split(/[\\/]/).pop()}${Number.isFinite(functions) ? ` (${functions} functions)` : ''}`, prompt: `fix the bug in ${file} and update its callers` };
  }
  writeHookFixture(dir);
  git(dir, 'init', '--quiet');
  return { dir, file: fixtureFile(0), label: 'fixture (200 files, 2,000 functions)', prompt: 'change how f0_3 computes its base value and update its callers' };
}

function openlore(dir: string, ...args: string[]): void {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1' } });
  if (r.status !== 0) throw new Error(`openlore ${args[0]} failed (${r.status}): ${(r.stderr || r.stdout).slice(-2000)}`);
}

/** Initialize and index the copy, then commit, so the session starts from a clean tree. */
function analyze(dir: string): void {
  if (!existsSync(join(dir, '.openlore', 'config.json'))) openlore(dir, 'init');
  if (git(dir, 'status', '--porcelain').trim()) {
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '--quiet', '-m', 'bench setup');
  }
  log('building the index (openlore analyze --no-embed)');
  const started = performance.now();
  openlore(dir, 'analyze', '--no-embed');
  log(`  index built in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

/** One harness payload per moment, in Claude Code's shape. A fresh session id per run. */
function payloads(dir: string, file: string, prompt: string) {
  const abs = join(dir, file);
  const firstLine = readFileSync(abs, 'utf8').split('\n').find(l => l.trim().length > 0) ?? '';
  return {
    'prompt-submitted': (s: string) => ({ session_id: s, cwd: dir, hook_event_name: 'UserPromptSubmit', prompt }),
    'before-edit': (s: string) => ({ session_id: s, cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: abs, old_string: firstLine, new_string: `${firstLine}\n// bench edit` } }),
    'after-tools (edit)': (s: string) => ({ session_id: s, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs, old_string: 'x', new_string: 'y' }, tool_response: {} }),
    'after-tools (shell)': (s: string) => ({ session_id: s, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok', stderr: '', interrupted: false } }),
    'before-stop': (s: string) => ({ session_id: s, cwd: dir, hook_event_name: 'Stop', stop_hook_active: false }),
  } as const;
}
type Moment = keyof ReturnType<typeof payloads>;

const CLI_ARGS: Record<Moment, string[]> = {
  'prompt-submitted': ['orient', '--inject'],
  'before-edit': ['hook', 'before-edit'],
  'after-tools (edit)': ['hook', 'after-tools'],
  'after-tools (shell)': ['hook', 'after-tools'],
  'before-stop': ['hook', 'before-stop'],
};

interface Row { moment: Moment; inProcess: { p50: number; p95: number; silent: number }; spawned: { p50: number; p95: number; silent: number }; outputChars: number }

async function main(): Promise<void> {
  if (!existsSync(CLI)) throw new Error('dist/cli/index.js is missing: run `npm run build` first');
  const { dir, file, label, prompt } = prepare();
  try {
    analyze(dir);
    // The session's change: one new function at the end of the target file.
    writeFileSync(join(dir, file), `${readFileSync(join(dir, file), 'utf8')}\nexport function benchAdded(n: number): number {\n  return n + 1;\n}\n`);
    const make = payloads(dir, file, prompt);
    const { runHook } = await import('../src/cli/commands/hook.js');
    const { buildInjection, extractPrompt } = await import('../src/cli/commands/orient-inject.js');

    // A dependency may print while a handler runs; keep it off the report.
    const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (() => true) as typeof process.stdout.write;
      try { return await fn(); } finally { process.stdout.write = write; }
    };
    const inProcess = async (moment: Moment, session: string): Promise<string> => {
      const raw = JSON.stringify(make[moment](session));
      if (moment === 'prompt-submitted') return quiet(() => buildInjection(dir, extractPrompt(raw)));
      const hookMoment = CLI_ARGS[moment][1] as 'before-edit' | 'after-tools' | 'before-stop';
      return (await quiet(() => runHook(hookMoment, raw, { cwd: dir }))).stdout;
    };

    const rows: Row[] = [];
    for (const moment of Object.keys(make) as Moment[]) {
      log(`measuring ${moment}`);
      const inTimes: number[] = [];
      let inSilent = 0;
      for (let k = 0; k < WARMUP + RUNS; k++) {
        const t = performance.now();
        const out = await inProcess(moment, `bench-in-${moment}-${k}`);
        if (k >= WARMUP) { inTimes.push(performance.now() - t); if (!out.trim()) inSilent++; }
      }
      const spawnTimes: number[] = [];
      let spawnSilent = 0;
      let outputChars = 0;
      for (let k = 0; k < RUNS; k++) {
        const input = JSON.stringify(make[moment](`bench-cli-${moment}-${k}`));
        const t = performance.now();
        const r = spawnSync(process.execPath, [CLI, ...CLI_ARGS[moment]], { cwd: dir, input, encoding: 'utf8' });
        spawnTimes.push(performance.now() - t);
        if (!r.stdout.trim()) spawnSilent++;
        outputChars = r.stdout.trim().length;
      }
      rows.push({
        moment,
        inProcess: { p50: percentile(inTimes, 50), p95: percentile(inTimes, 95), silent: inSilent },
        spawned: { p50: percentile(spawnTimes, 50), p95: percentile(spawnTimes, 95), silent: spawnSilent },
        outputChars,
      });
    }

    if (AS_JSON) {
      process.stdout.write(`${JSON.stringify({ label, runs: RUNS, warmup: WARMUP, node: process.version, platform: `${process.platform}-${process.arch}`, rows }, null, 2)}\n`);
      return;
    }
    const ms = (n: number) => `${Math.round(n).toLocaleString('en-US')} ms`;
    const lines = [
      `${label}: ${RUNS} runs per moment (${WARMUP} warm-up in-process), Node ${process.version}, ${process.platform}-${process.arch}`,
      '',
      '| Moment | In-process p50 | In-process p95 | Spawned p50 | Spawned p95 | Silent runs (in / spawned) | Last output (chars) |',
      '|---|---|---|---|---|---|---|',
      ...rows.map(r => `| ${r.moment} | ${ms(r.inProcess.p50)} | ${ms(r.inProcess.p95)} | ${ms(r.spawned.p50)} | ${ms(r.spawned.p95)} | ${r.inProcess.silent} / ${r.spawned.silent} | ${r.outputChars.toLocaleString('en-US')} |`),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (error: unknown) => {
  log(`bench-hooks: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
