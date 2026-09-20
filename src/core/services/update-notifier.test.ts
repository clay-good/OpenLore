import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  isNewer,
  fetchLatestVersion,
  npmViewInvocation,
  npmViewCwd,
  readAnswerVersion,
  terminateChildOnParentExit,
  notifyIfUpdateAvailable,
  refreshCache,
  formatBanner,
  type NotifyOptions,
  type UpdateCache,
} from './update-notifier.js';

function tmpCache(): string {
  return join(mkdtempSync(join(tmpdir(), 'openlore-upd-')), 'update-check.json');
}

function fakeStream(): { write(s: string): void; isTTY: boolean; out: string } {
  return { out: '', isTTY: true, write(s: string) { this.out += s; } };
}

function okFetcher(version: string): NotifyOptions['fetcher'] {
  return async () => ({ ok: true, json: async () => ({ version }) });
}

describe('isNewer', () => {
  it('true only when latest core version is strictly greater', () => {
    expect(isNewer('2.1.3', '2.1.4')).toBe(true);
    expect(isNewer('2.1.3', '2.2.0')).toBe(true);
    expect(isNewer('2.1.3', '3.0.0')).toBe(true);
    expect(isNewer('2.1.3', '2.1.3')).toBe(false);
    expect(isNewer('2.1.4', '2.1.3')).toBe(false);
  });

  it('ignores prerelease/build suffixes and bad input', () => {
    expect(isNewer('2.1.3', '2.1.4-beta.1')).toBe(true);
    expect(isNewer('2.1.3-rc.1', '2.1.3')).toBe(false); // same core
    expect(isNewer('garbage', '2.1.4')).toBe(false);
    expect(isNewer('2.1.3', 'not-a-version')).toBe(false);
  });
});

describe('fetchLatestVersion', () => {
  it('terminates a detached npm lookup when the parent exits and removes the listener afterward', () => {
    const existing = new Set(process.listeners('exit'));
    const child = { killed: false, kill: vi.fn(() => true) };
    const cleanup = terminateChildOnParentExit(child);
    const exitListener = process.listeners('exit').find((listener) => !existing.has(listener));

    expect(exitListener).toBeDefined();
    exitListener?.(0);
    expect(child.kill).toHaveBeenCalledOnce();

    cleanup();
    expect(process.listeners('exit')).not.toContain(exitListener);
  });

  it('delegates the default registry lookup to npm so .npmrc transport settings apply', () => {
    const invocation = npmViewInvocation('linux', {
      npmExecPath: '/opt/npm/lib/npm-cli.js',
      nodeExecutable: '/opt/node/bin/node',
    });
    expect(invocation).toEqual({
      command: '/opt/node/bin/node',
      args: ['/opt/npm/lib/npm-cli.js', 'view', 'openlore@latest', 'version', '--json'],
    });
    expect(invocation.args.join(' ')).not.toContain('registry.npmjs.org');
  });

  it('reads the version from every answer shape npm and the registry produce', () => {
    // npm 10/11 answers `view <pkg>@latest version --json` with an ARRAY; older npm with a bare
    // string; the registry endpoint with the `{ version }` document. An unread array meant the
    // notifier reported "no update" forever.
    expect(readAnswerVersion(['3.2.0'])).toBe('3.2.0');
    expect(readAnswerVersion(['3.1.1', '3.2.0'])).toBe('3.2.0');
    expect(readAnswerVersion('3.2.0')).toBe('3.2.0');
    expect(readAnswerVersion({ version: '3.2.0' })).toBe('3.2.0');
    expect(readAnswerVersion([])).toBeNull();
    expect(readAnswerVersion(null)).toBeNull();
    expect(readAnswerVersion({})).toBeNull();
    expect(readAnswerVersion(42)).toBeNull();
  });

  it('reports the version an array answer carries, end to end', async () => {
    const latest = await fetchLatestVersion({ lookup: async () => ['3.9.1'] });
    expect(latest).toBe('3.9.1');
  });

  it('runs the npm lookup outside the analyzed repository, so a repo .npmrc cannot steer it', async () => {
    expect(npmViewCwd()).toBe(homedir());
    expect(npmViewCwd()).not.toBe(process.cwd());
    const source = await readFile(new URL('./update-notifier.ts', import.meta.url), 'utf8');
    expect(source).toContain('cwd: npmViewCwd(),');
  });

  it('resolves npm view through the npm CLI entry point on Windows', () => {
    expect(npmViewInvocation('win32', {
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npmExecPath: '',
      pathValue: '',
      fileExists: () => true,
    })).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
        'view',
        'openlore@latest',
        'version',
        '--json',
      ],
    });
  });

  it('uses an injected package-manager lookup without issuing a direct fetch', async () => {
    const lookup = vi.fn(async () => '9.9.9');
    const fetcher = vi.fn(okFetcher('0.0.1'));
    expect(await fetchLatestVersion({ lookup, fetcher })).toBe('9.9.9');
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ background: false }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not bypass .npmrc after npm reports a registry or authentication error', async () => {
    const previousExecPath = process.env.npm_execpath;
    const directFetch = vi.fn(okFetcher('0.0.1'));
    process.env.npm_execpath = join(tmpdir(), 'missing-openlore-npm-cli.js');
    vi.stubGlobal('fetch', directFetch);
    try {
      expect(await fetchLatestVersion()).toBeNull();
      expect(directFetch).not.toHaveBeenCalled();
    } finally {
      if (previousExecPath === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = previousExecPath;
      vi.unstubAllGlobals();
    }
  });

  it('uses the direct registry fallback only when npm is absent', async () => {
    const previousExecPath = process.env.npm_execpath;
    const previousPath = process.env.PATH;
    const directFetch = vi.fn(okFetcher('8.8.8'));
    delete process.env.npm_execpath;
    // An empty PATH is what absence looks like on POSIX. On Windows npm is found beside the
    // running Node executable, PATH or not, so absence is stated through the runtime instead.
    process.env.PATH = '';
    vi.stubGlobal('fetch', directFetch);
    try {
      expect(await fetchLatestVersion({
        npmRuntime: { npmExecPath: '', pathValue: '', fileExists: () => false },
      })).toBe('8.8.8');
      expect(directFetch).toHaveBeenCalledWith(
        expect.stringContaining('registry.npmjs.org/openlore/latest'),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      if (previousExecPath === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = previousExecPath;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      vi.unstubAllGlobals();
    }
  });

  it('returns the version from the registry payload', async () => {
    expect(await fetchLatestVersion({ fetcher: okFetcher('9.9.9') })).toBe('9.9.9');
  });
  it('returns null on non-ok, throw, or missing version (never throws)', async () => {
    expect(await fetchLatestVersion({ fetcher: async () => ({ ok: false, json: async () => ({}) }) })).toBeNull();
    expect(await fetchLatestVersion({ fetcher: async () => { throw new Error('net'); } })).toBeNull();
    expect(await fetchLatestVersion({ fetcher: async () => ({ ok: true, json: async () => ({}) }) })).toBeNull();
  });
});

describe('refreshCache', () => {
  it('writes latest + timestamp to the cache file', async () => {
    const cacheFile = tmpCache();
    await refreshCache({ cacheFile, fetcher: okFetcher('5.0.0'), now: () => 1000 });
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as UpdateCache;
    expect(cache).toEqual({ latest: '5.0.0', checkedAt: 1000 });
  });
});

describe('notifyIfUpdateAvailable', () => {
  const base = (over: Partial<NotifyOptions>): NotifyOptions => ({
    env: {}, now: () => 5000, fetcher: okFetcher('2.1.3'), ...over,
  });

  it('prints a banner when the cached latest is newer', () => {
    const cacheFile = tmpCache();
    writeFileSync(cacheFile, JSON.stringify({ latest: '2.2.0', checkedAt: 5000 }));
    const stream = fakeStream();
    const printed = notifyIfUpdateAvailable('2.1.3', base({ cacheFile, stream }));
    expect(printed).toBe(true);
    expect(stream.out).toContain('2.1.3 → 2.2.0');
    expect(stream.out).toContain('openlore update');
  });

  it('does not print when up to date', () => {
    const cacheFile = tmpCache();
    writeFileSync(cacheFile, JSON.stringify({ latest: '2.1.3', checkedAt: 5000 }));
    const stream = fakeStream();
    expect(notifyIfUpdateAvailable('2.1.3', base({ cacheFile, stream }))).toBe(false);
    expect(stream.out).toBe('');
  });

  it('is suppressed by CI, opt-out env, and non-TTY', () => {
    const cacheFile = tmpCache();
    writeFileSync(cacheFile, JSON.stringify({ latest: '9.9.9', checkedAt: 5000 }));
    for (const env of [{ CI: '1' }, { OPENLORE_NO_UPDATE_NOTIFIER: '1' }, { NO_UPDATE_NOTIFIER: '1' }]) {
      const stream = fakeStream();
      expect(notifyIfUpdateAvailable('2.1.3', base({ cacheFile, stream, env }))).toBe(false);
      expect(stream.out).toBe('');
    }
    // non-TTY
    const stream = fakeStream();
    stream.isTTY = false;
    expect(notifyIfUpdateAvailable('2.1.3', base({ cacheFile, stream, isTTY: false }))).toBe(false);
    expect(stream.out).toBe('');
  });

  it('refreshes a stale/missing cache in the background without blocking', async () => {
    const cacheFile = tmpCache(); // missing
    const stream = fakeStream();
    notifyIfUpdateAvailable('2.1.3', base({ cacheFile, stream, fetcher: okFetcher('4.4.4'), now: () => 99999 }));
    // Background refresh is fire-and-forget; give the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(cacheFile)).toBe(true);
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as UpdateCache;
    expect(cache.latest).toBe('4.4.4');
  });
});

describe('formatBanner', () => {
  it('is a self-consistent box containing both versions', () => {
    const b = formatBanner('1.0.0', '2.0.0');
    expect(b).toContain('1.0.0 → 2.0.0');
    expect(b).toContain('┌');
    expect(b).toContain('┘');
  });
});
