/**
 * Adaptive heap re-exec — end-to-end against the real built CLI binary.
 *
 * The unit tests exercise the pure planner ({@link planHeapReexec}) and the cgroup parsers. This
 * file exercises the SIDE-EFFECTING orchestrator the way a real invocation does: it spawns
 * `node dist/cli/index.js analyze` on a tiny temp repo and asserts the observable contract of the
 * re-exec described in `src/cli/heap-sizing.ts`:
 *
 *   - a re-exec actually fires when the target heap beats the current one, and is transparent: the
 *     single `[openlore] heap sized to …` disclosure goes to STDERR (never stdout, which carries
 *     the MCP JSON-RPC stream), and the analyze still completes and writes its artifacts;
 *   - the opt-out (`OPENLORE_NO_AUTO_HEAP=1`) suppresses the re-exec;
 *   - at-most-once: the marker (`OPENLORE_HEAP_REEXEC=1`) suppresses any further re-exec.
 *
 * To force a re-exec deterministically without a user-set `--max-old-space-size` (which SUPPRESSES
 * re-exec by design), the test measures this Node's default old-space limit and sets
 * `OPENLORE_HEAP_MB` a little above it — the explicit-target path re-execs whenever the target
 * exceeds the current heap.
 *
 * Skipped automatically when dist/ is not built (so it never breaks cold CI; this is an
 * *.integration.test.ts, excluded from `npm run test:run`). Run with:
 *   npm run build && npx vitest run --config vitest.integration.config.ts src/cli/heap-reexec.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(import.meta.dirname, '../../');
const CLI = join(REPO_ROOT, 'dist/cli/index.js');
const haveCli = existsSync(CLI);

/** The `heap sized to` disclosure prefix — asserted present on stderr / absent from stdout. */
const HEAP_LINE = 'heap sized to';

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the built CLI with stdout and stderr captured SEPARATELY (execFileSync merges/loses one),
 * because the whole point is which stream the disclosure lands on. `extraEnv` is layered over the
 * inherited environment; a value of `undefined` deletes the key.
 */
function runCli(args: string[], extraEnv: Record<string, string | undefined>, cwd: string): Run {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  const r = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf-8', env });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** This Node's default old-space heap limit, in MB, measured in a child with no heap flag. */
function defaultHeapLimitMb(): number {
  const out = execFileSync(
    'node',
    ['-e', 'process.stdout.write(String(require("v8").getHeapStatistics().heap_size_limit))'],
    { encoding: 'utf-8' },
  );
  return Math.round(Number(out.trim()) / (1024 * 1024));
}

/** Count non-overlapping occurrences of a needle. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe.skipIf(!haveCli)('adaptive heap re-exec — e2e against the built binary', () => {
  let repo = '';
  // A target comfortably above the current default so the explicit-target path always re-execs.
  const aboveHeapMb = String(defaultHeapLimitMb() + 512);

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'heap-reexec-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'src', 'a.ts'),
      'export function classify(n: number): string {\n' +
        "  if (n < 0) { return 'neg'; }\n" +
        '  for (let i = 0; i < n; i++) { if (i % 2 === 0) { continue; } }\n' +
        "  return n > 10 ? 'big' : 'small';\n" +
        '}\n',
    );
    writeFileSync(
      join(repo, 'src', 'b.ts'),
      "import { classify } from './a.js';\n" +
        "export function wrap(x: number): string { return classify(x); }\n",
    );
    // analyze requires a config — `openlore init` writes one.
    try {
      execFileSync('node', [CLI, 'init'], { cwd: repo, stdio: 'ignore' });
    } catch {
      /* init is best-effort; a missing config surfaces as a clear analyze failure below */
    }
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('re-execs, discloses ONCE on stderr (never stdout), and still completes the analyze', () => {
    const r = runCli(
      ['analyze', '--no-embed', '--force'],
      { OPENLORE_HEAP_MB: aboveHeapMb, OPENLORE_NO_AUTO_HEAP: undefined, OPENLORE_HEAP_REEXEC: undefined },
      repo,
    );

    // The re-exec disclosure appears exactly once, on STDERR only.
    expect(count(r.stderr, HEAP_LINE), `stderr:\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain(`${HEAP_LINE} ${aboveHeapMb} MB`);
    expect(r.stdout).not.toContain(HEAP_LINE);

    // Transparent: the analyze completes and writes its artifacts through the larger-heap child.
    expect(r.status).toBe(0);
    expect(existsSync(join(repo, '.openlore', 'analysis', 'llm-context.json'))).toBe(true);
  }, 120_000);

  it('opt-out (OPENLORE_NO_AUTO_HEAP=1) suppresses the re-exec entirely', () => {
    const r = runCli(
      ['analyze', '--no-embed', '--force'],
      { OPENLORE_HEAP_MB: aboveHeapMb, OPENLORE_NO_AUTO_HEAP: '1' },
      repo,
    );
    expect(r.stderr).not.toContain(HEAP_LINE);
    expect(r.stdout).not.toContain(HEAP_LINE);
    expect(r.status).toBe(0);
  }, 120_000);

  it('at-most-once: the marker (OPENLORE_HEAP_REEXEC=1) suppresses any further re-exec', () => {
    // Simulates the already-re-executed child: even with a target above the current heap, a process
    // carrying the marker must never re-exec again (the marker is checked first in planHeapReexec).
    const r = runCli(
      ['analyze', '--no-embed', '--force'],
      { OPENLORE_HEAP_MB: aboveHeapMb, OPENLORE_NO_AUTO_HEAP: undefined, OPENLORE_HEAP_REEXEC: '1' },
      repo,
    );
    expect(r.stderr).not.toContain(HEAP_LINE);
    expect(r.stdout).not.toContain(HEAP_LINE);
    expect(r.status).toBe(0);
  }, 120_000);
});
