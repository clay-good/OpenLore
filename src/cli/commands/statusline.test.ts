import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndexStatus } from './status.js';

const collect = vi.hoisted(() => vi.fn());
vi.mock('./status.js', () => ({ collectIndexStatus: collect }));

const { renderStatusLine, statusLabel, workingDirectoryFromInput } = await import('./statusline.js');

const ESC = '\x1b';
const base: IndexStatus = {
  indexPresent: true,
  retrievalMode: 'keyword',
  keywordCause: 'no-provider-configured',
  configuredProvider: null,
  builtAt: '2026-10-01T00:00:00.000Z',
  staleFiles: [],
  staleFilesTruncated: false,
  degraded: [],
};

describe('statusLabel', () => {
  it.each([
    [{}, 'green', 'OpenLore: index ready'],
    [{ indexPresent: false }, 'yellow', 'OpenLore: no index'],
    [{ degraded: ['vector'] }, 'red', 'OpenLore: index degraded'],
    [{ configUnreadable: true }, 'yellow', 'OpenLore: check index status'],
    [{ staleFilesUnknown: true }, 'yellow', 'OpenLore: freshness unknown'],
    [{ staleFiles: ['a.ts', 'b.ts'], staleFilesTruncated: true }, 'yellow', 'OpenLore: index stale (2+)'],
    // change: default-decision-autopilot-with-visible-trace
    [{ governance: { unreviewed: 2 } }, 'green', 'OpenLore: index ready · 2 to review'],
    [{ governance: { unreviewed: 0 } }, 'green', 'OpenLore: index ready'],
  ] as const)('%j → %s', (patch, color, text) => {
    expect(statusLabel({ ...base, ...patch } as unknown as IndexStatus)).toEqual({ color, text });
  });
});

describe('workingDirectoryFromInput', () => {
  it('prefers the project dir over the current dir and cwd', () => {
    const input = JSON.stringify({ cwd: '/c', workspace: { current_dir: '/repo/sub', project_dir: '/repo' } });
    expect(workingDirectoryFromInput(input, '/fallback')).toBe('/repo');
  });

  it('falls back through current_dir and cwd', () => {
    expect(workingDirectoryFromInput(JSON.stringify({ workspace: { current_dir: '/cur' } }), '/f')).toBe('/cur');
    expect(workingDirectoryFromInput(JSON.stringify({ cwd: '/c' }), '/f')).toBe('/c');
  });

  it.each(['', 'not json', 'null', '42', '{"cwd": 7}', '{"workspace": null}', '{"cwd": ""}'])(
    'uses the fallback for %j', (input) => {
      expect(workingDirectoryFromInput(input, '/fallback')).toBe('/fallback');
    },
  );
});

describe('renderStatusLine', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    collect.mockReset();
  });
  afterEach(() => { process.env = saved; });

  it('colors the label with ANSI even though stdout is a pipe', async () => {
    collect.mockResolvedValue(base);
    const out = await renderStatusLine('{"workspace":{"project_dir":"/repo"}}', '/f');
    expect(collect).toHaveBeenCalledWith('/repo');
    expect(out).toContain(`${ESC}[32m`);
    expect(out).toContain('OpenLore: index ready');
  });

  it('honors a non-empty NO_COLOR and ignores an empty one', async () => {
    collect.mockResolvedValue(base);
    process.env.NO_COLOR = '1';
    expect(await renderStatusLine('', '/f')).toBe('OpenLore: index ready');
    process.env.NO_COLOR = '';
    expect(await renderStatusLine('', '/f')).toContain(`${ESC}[32m`);
  });

  it('honors FORCE_COLOR=0', async () => {
    collect.mockResolvedValue(base);
    process.env.FORCE_COLOR = '0';
    expect(await renderStatusLine('', '/f')).toBe('OpenLore: index ready');
  });

  it('fails soft to a yellow unknown state, never throwing or printing a stack', async () => {
    collect.mockRejectedValue(new Error('boom\n    at secret (/x.js:1:1)'));
    const out = await renderStatusLine('', '/f');
    expect(out).toBe(`${ESC}[33mOpenLore: status unknown${ESC}[39m`);
  });
});

describe('renderStatusLine against a real directory', () => {
  it('reports no index for a directory without .openlore', async () => {
    const real = await vi.importActual<typeof import('./status.js')>('./status.js');
    collect.mockImplementation(real.collectIndexStatus);
    const dir = await mkdtemp(join(tmpdir(), 'openlore-statusline-'));
    try {
      process.env.NO_COLOR = '1';
      expect(await renderStatusLine(JSON.stringify({ cwd: dir }), '/f')).toBe('OpenLore: no index');
    } finally {
      delete process.env.NO_COLOR;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
