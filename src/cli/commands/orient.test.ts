/**
 * Tests for the `openlore orient` CLI command.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    error: vi.fn(), info: vi.fn(), section: vi.fn(), success: vi.fn(),
    warning: vi.fn(), discovery: vi.fn(), blank: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock('../../core/services/mcp-handlers/orient.js', () => ({
  handleOrient: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
});

import { orientCommand, readStdin } from './orient.js';
import { handleOrient } from '../../core/services/mcp-handlers/orient.js';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';

const mockHandleOrient = vi.mocked(handleOrient);
const mockExistsSync = vi.mocked(existsSync);

describe('orient command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockHandleOrient.mockReset();
    mockExistsSync.mockReset().mockReturnValue(false);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/fake/proj');
    process.exitCode = undefined;
    // orientCommand is a module-level singleton; commander retains option
    // values between parseAsync() calls, so reset them so one test's flags
    // (e.g. --limit 0) don't bleed into the next.
    for (const opt of ['task', 'directory', 'limit', 'json', 'lean', 'tokenBudget', 'metrics', 'inject']) {
      orientCommand.setOptionValue(opt, undefined);
    }
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
    process.exitCode = undefined;
  });

  function output(): string {
    return consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  }

  describe('command configuration', () => {
    it('has correct name and description', () => {
      expect(orientCommand.name()).toBe('orient');
      expect(orientCommand.description().toLowerCase()).toContain('insertion');
    });

    it('exposes --task, --json, --directory and --limit options', () => {
      const longs = orientCommand.options.map(o => o.long);
      expect(longs).toContain('--task');
      expect(longs).toContain('--json');
      expect(longs).toContain('--directory');
      expect(longs).toContain('--limit');
      expect(longs).toContain('--metrics');
      expect(longs).toContain('--inject');
    });
  });

  // Regression (v2.1.4 QA): `openlore orient "<task>"` — the most natural thing a user/agent
  // types — used to silently fall through to the no-task session primer and exit 0, doing no
  // orientation. A bare positional task must now be honored, while NO task still prints the
  // primer (so the install SessionStart hook `orient --json` is unaffected).
  describe('positional [task] argument', () => {
    it('honors a bare positional task instead of printing the no-task primer', async () => {
      mockHandleOrient.mockResolvedValue({
        task: 'add rate limiting',
        searchMode: 'keyword',
        relevantFiles: ['src/rl.ts'],
        relevantFunctions: [{ name: 'rateLimit', filePath: 'src/rl.ts', score: 0.9, fanIn: 3 }],
        specDomains: [],
        callPaths: [],
        suggestedTools: ['orient'],
      });
      await orientCommand.parseAsync(['add rate limiting'], { from: 'user' });
      const out = output();
      expect(mockHandleOrient).toHaveBeenCalled();
      expect(out).toContain('rateLimit'); // it actually oriented…
      expect(out).not.toContain('architectural memory is active'); // …NOT the no-task primer
    });

    it('with NO task still prints the session-start primer (install hook unaffected)', async () => {
      await orientCommand.parseAsync([], { from: 'user' });
      // Both primer variants (analysis present / absent) guide to `orient --task`,
      // and neither runs an orientation — that's what keeps the SessionStart hook safe.
      expect(output()).toContain('orient --task');
      expect(output()).not.toContain('rateLimit');
    });
  });

  describe('--inject (task-scoped injection hook)', () => {
    it('emits an attributed, ignorable block for a strong match and never errors', async () => {
      mockHandleOrient.mockResolvedValue({
        task: 'auth flow',
        searchMode: 'hybrid',
        relevantFiles: ['src/auth/mw.ts'],
        relevantFunctions: [
          { name: 'authMiddleware', filePath: 'src/auth/mw.ts', score: 0.8, fanIn: 5 },
          { name: 'verify', filePath: 'src/auth/mw.ts', score: 0.6, fanIn: 2 },
        ],
        specDomains: ['auth'],
        callPaths: [],
        suggestedTools: ['orient'],
      });
      await orientCommand.parseAsync(['--inject', '--task', 'auth flow'], { from: 'user' });
      expect(output()).toContain('[OpenLore]');
      expect(output().toLowerCase()).toContain('ignore');
      expect(process.exitCode).toBeUndefined();
    });

    it('emits the pointer line (never throws) when handleOrient returns an error result', async () => {
      mockHandleOrient.mockResolvedValue({ error: 'No analysis found.' });
      await orientCommand.parseAsync(['--inject', '--task', 'whatever'], { from: 'user' });
      expect(output()).toContain('Structural context is available');
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('no-task primer (used by the install SessionStart hook)', () => {
    it('prints a primer and does NOT call handleOrient when no task is given', async () => {
      await orientCommand.parseAsync([], { from: 'user' });
      expect(mockHandleOrient).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('--json primer emits parseable JSON with openlore status', async () => {
      mockExistsSync.mockReturnValue(false);
      await orientCommand.parseAsync(['--json'], { from: 'user' });
      const parsed = JSON.parse(output());
      expect(parsed.openlore).toBe('no-analysis');
    });

    it('--json primer reports "ready" when analysis exists', async () => {
      mockExistsSync.mockReturnValue(true);
      await orientCommand.parseAsync(['--json'], { from: 'user' });
      const parsed = JSON.parse(output());
      expect(parsed.openlore).toBe('ready');
    });
  });

  describe('with a task', () => {
    it('passes task, directory and limit through to handleOrient', async () => {
      mockHandleOrient.mockResolvedValue({ task: 't', searchMode: 'bm25_fallback', relevantFunctions: [] });
      await orientCommand.parseAsync(['--task', 'add rate limiting', '--limit', '7'], { from: 'user' });
      // args: (dir, task, limit, tokenBudget=undefined, lean=false).
      expect(mockHandleOrient).toHaveBeenCalledWith('/fake/proj', 'add rate limiting', 7, undefined, false);
    });

    it('passes --token-budget through to handleOrient', async () => {
      mockHandleOrient.mockResolvedValue({ task: 't', searchMode: 'bm25_fallback', relevantFunctions: [] });
      await orientCommand.parseAsync(['--task', 'auth flow', '--limit', '5', '--token-budget', '400'], { from: 'user' });
      expect(mockHandleOrient).toHaveBeenCalledWith('/fake/proj', 'auth flow', 5, 400, false);
    });

    it('passes --lean through to handleOrient (Spec 27)', async () => {
      // Commander v12 retains option values across parseAsync on the same command
      // instance, so clear --token-budget that a prior test set.
      orientCommand.setOptionValue('tokenBudget', undefined);
      mockHandleOrient.mockResolvedValue({ task: 't', searchMode: 'bm25_fallback', relevantFunctions: [], lean: true });
      await orientCommand.parseAsync(['--task', 'who calls foo', '--lean'], { from: 'user' });
      expect(mockHandleOrient).toHaveBeenCalledWith('/fake/proj', 'who calls foo', 5, undefined, true);
    });

    it('--json emits the full result object as JSON', async () => {
      mockHandleOrient.mockResolvedValue({ task: 'x', searchMode: 'hybrid', relevantFunctions: [] });
      await orientCommand.parseAsync(['--json', '--task', 'x'], { from: 'user' });
      const parsed = JSON.parse(output());
      expect(parsed.searchMode).toBe('hybrid');
    });

    it('rejects a non-positive --limit', async () => {
      await orientCommand.parseAsync(['--task', 'x', '--limit', '0'], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(mockHandleOrient).not.toHaveBeenCalled();
    });

    it('sets exitCode=1 and emits JSON error when handleOrient throws (--json)', async () => {
      mockHandleOrient.mockRejectedValue(new Error('boom'));
      await orientCommand.parseAsync(['--json', '--task', 'x'], { from: 'user' });
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(output());
      expect(parsed.error).toBe('boom');
    });

    it('--json keeps stdout pure JSON even when the handler logs to stdout', async () => {
      // handleOrient → validateDirectory writes "[ok] Successfully validated…"
      // to stdout via console.log. In --json mode that must be routed away so
      // wrapper scripts get parseable JSON. Simulate the stray write.
      mockHandleOrient.mockImplementation(async () => {
        console.log('[ok] Successfully validated directory: /fake/proj');
        return { task: 'x', searchMode: 'bm25_fallback', relevantFunctions: [] };
      });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await orientCommand.parseAsync(['--json', '--task', 'x'], { from: 'user' });
      // The stray line must NOT be on the captured console.log stdout…
      expect(output()).not.toContain('Successfully validated');
      // …and what IS on stdout must be valid JSON.
      const parsed = JSON.parse(output());
      expect(parsed.searchMode).toBe('bm25_fallback');
      // The stray line was redirected to stderr instead.
      const stderrText = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(stderrText).toContain('Successfully validated');
      stderrSpy.mockRestore();
    });
  });

  describe('--metrics (opt-in performance readout, Issue #128)', () => {
    it('reports wall time and output size to stderr, leaving stdout JSON clean', async () => {
      mockHandleOrient.mockResolvedValue({ task: 'x', searchMode: 'hybrid', relevantFunctions: [] });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await orientCommand.parseAsync(['--json', '--metrics', '--task', 'x'], { from: 'user' });
      const stderrText = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(stderrText).toContain('[orient:metrics]');
      expect(stderrText).toMatch(/wall=[\d.]+ms/);
      expect(stderrText).toMatch(/output≈\d+ tokens/);
      // The metrics line must not leak onto stdout (wrappers parse stdout as JSON).
      const parsed = JSON.parse(output());
      expect(parsed.searchMode).toBe('hybrid');
      stderrSpy.mockRestore();
    });

    it('writes no metrics line when --metrics is omitted (off by default)', async () => {
      mockHandleOrient.mockResolvedValue({ task: 'x', searchMode: 'hybrid', relevantFunctions: [] });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await orientCommand.parseAsync(['--json', '--task', 'x'], { from: 'user' });
      const stderrText = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(stderrText).not.toContain('[orient:metrics]');
      stderrSpy.mockRestore();
    });
  });

  // readStdin underlies --inject's stdin path. The load-bearing property is that
  // it never keeps the process alive: a writer that opens the pipe but never
  // closes it must not stall the user's turn (regression: the fallback timer
  // resolved the promise but left stdin referenced, so the process hung at EOF).
  describe('readStdin (hook stdin, fail-open)', () => {
    function fakeStream(): PassThrough & { isTTY?: boolean } {
      return new PassThrough() as PassThrough & { isTTY?: boolean };
    }

    it('resolves with the piped payload when the stream ends', async () => {
      const s = fakeStream();
      const p = readStdin(s as unknown as NodeJS.ReadStream, 1000);
      s.write('{"prompt":"hi"}');
      s.end();
      expect(await p).toBe('{"prompt":"hi"}');
    });

    it('resolves via the fallback (and detaches) when stdin stays open past EOF', async () => {
      const s = fakeStream();
      const p = readStdin(s as unknown as NodeJS.ReadStream, 30);
      s.write('partial');
      // deliberately never call s.end() — simulate a writer holding the pipe open
      expect(await p).toBe('partial');
      // The stream must be torn down so it can't keep the event loop alive.
      expect(s.isPaused()).toBe(true);
      expect(s.listenerCount('data')).toBe(0);
    });

    it('resolves empty immediately for a TTY (nothing piped)', async () => {
      const s = fakeStream();
      s.isTTY = true;
      expect(await readStdin(s as unknown as NodeJS.ReadStream, 1000)).toBe('');
    });
  });
});
