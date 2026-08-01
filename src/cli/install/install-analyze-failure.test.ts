/**
 * `openlore install` must not claim the index was built when it was not
 * (change: bulletproof-background-index).
 *
 * `analyze` reports its own failures by SETTING `process.exitCode` and returning — it does not
 * throw. So `parseAsync` resolved normally, install's `catch` never ran, and install printed
 * `[ok] Index built — orient() will return results in your next session.` directly underneath
 * analyze's own `[error] Analysis failed: EACCES …`.
 *
 * That is the single worst failure shape for this tool. The user is told setup succeeded, and the
 * next thing that happens is `orient` returning nothing on a repository the user believes is
 * indexed — which reads as "this codebase has no functions", not as "setup failed".
 *
 * Analyze is mocked here rather than provoked with a real EACCES: a CI container often runs as
 * root, where a read-only directory is still writable and the failure cannot be reproduced at all.
 * The seam under test is install's reaction to a failing analyze, which is exactly what the mock
 * reproduces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const parseAsync = vi.fn();

vi.mock('../commands/analyze.js', () => ({
  analyzeCommand: {
    setOptionValue: vi.fn(),
    parseAsync,
  },
}));

import { buildIndex } from './index.js';
import { logger } from '../../utils/logger.js';

let dir: string;
let exitCodeBefore: typeof process.exitCode;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ol-install-fail-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'tmp', version: '1.0.0' }));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'index.ts'), 'export function greet() { return 1; }\n');
  exitCodeBefore = process.exitCode;
  parseAsync.mockReset();
});

afterEach(async () => {
  process.exitCode = exitCodeBefore;
  await rm(dir, { recursive: true, force: true });
});

describe('install — a failed analyze is never reported as success', () => {
  it('warns and gives a next step instead of "Index built"', async () => {
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    // Exactly how analyze fails: set the code, return, never throw.
    parseAsync.mockImplementation(async () => { process.exitCode = 1; });

    try {
      await buildIndex(dir);

      const claimed = success.mock.calls.map(c => String(c[0])).join('\n');
      expect(claimed, 'install claimed the index was built after analyze failed').not.toMatch(/Index built/);

      const warned = warning.mock.calls.map(c => String(c[0])).join('\n');
      expect(warned, 'the failure was not surfaced at all').toMatch(/did NOT finish building/i);

      // A dead end is barely better than a false success — the user needs the recovery step.
      const nextStep = info.mock.calls.find(([k]) => k === 'Next step')?.[1];
      expect(String(nextStep ?? '')).toContain('openlore analyze');
    } finally {
      success.mockRestore(); warning.mockRestore(); info.mockRestore();
    }
  }, 30_000);

  it('still reports success on the happy path', async () => {
    // The guard must key on analyze's OWN outcome. Suppressing "Index built" whenever anything is
    // wrong would make every successful install look broken.
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    parseAsync.mockImplementation(async () => { /* analyze succeeds */ });

    try {
      await buildIndex(dir);
      expect(success.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/Index built/);
      expect(warning.mock.calls.map(c => String(c[0])).join('\n')).not.toMatch(/did NOT finish/i);
    } finally {
      success.mockRestore(); warning.mockRestore();
    }
  }, 30_000);

  it('does not blame analyze for a non-zero exit code that was already set', async () => {
    // An earlier install step (a surface that could not be wired) may have set `process.exitCode`
    // before analyze ever ran. Reading the code without a baseline would report a perfectly good
    // index as failed.
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    process.exitCode = 1;
    parseAsync.mockImplementation(async () => { /* analyze succeeds */ });

    try {
      await buildIndex(dir);
      expect(
        success.mock.calls.map(c => String(c[0])).join('\n'),
        'a pre-existing exit code was misattributed to analyze'
      ).toMatch(/Index built/);
      expect(warning.mock.calls.map(c => String(c[0])).join('\n')).not.toMatch(/did NOT finish/i);
    } finally {
      success.mockRestore(); warning.mockRestore();
    }
  }, 30_000);
});
