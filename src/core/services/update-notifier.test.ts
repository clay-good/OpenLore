import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isNewer,
  fetchLatestVersion,
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
