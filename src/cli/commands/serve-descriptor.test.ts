/**
 * Tests for serve-descriptor — the one validator for the untrusted
 * `.openlore/serve.json` daemon-discovery artifact (mcp-security:
 * ServeDescriptorValidatedAtEveryReader).
 *
 * Two jobs:
 *   1. The validator fails closed on every poisoned field and round-trips a
 *      healthy loopback descriptor unchanged.
 *   2. A source-level coverage guard pins that every production reader of
 *      serve.json resolves it through this module — a future reader that reads
 *      the file raw fails the guard, naming itself.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateServeDescriptor,
  validateServeHealth,
  readServeDescriptor,
  serveHttpBaseUrl,
} from './serve-descriptor.js';

const HEALTHY = { port: 8080, pid: 4242, host: '127.0.0.1', token: 't', startedAt: 's', version: 'v' };
const HEALTH = {
  ok: true,
  presetDispatchEnforced: true,
  root: '/tmp/project',
  pid: 4242,
  preset: 'full',
  tools: ['orient'],
  tokenProtected: true,
  tokenAuthenticated: true,
  draining: false,
};

it('formats IPv4 and IPv6 loopback origins safely', () => {
  expect(serveHttpBaseUrl('127.0.0.1', 8080)).toBe('http://127.0.0.1:8080');
  expect(serveHttpBaseUrl('::1', 8080)).toBe('http://[::1]:8080');
});

describe('validateServeHealth', () => {
  it('requires an authenticated enforced surface bound to the expected root', () => {
    expect(validateServeHealth(HEALTH, '/tmp/project')).toEqual(HEALTH);
    for (const bad of [
      { ...HEALTH, presetDispatchEnforced: false },
      { ...HEALTH, root: '/tmp/other' },
      { ...HEALTH, pid: 0 },
      { ...HEALTH, tools: [1] },
      { ...HEALTH, tokenProtected: 'yes' },
      { ...HEALTH, tokenAuthenticated: false },
      { ...HEALTH, draining: 'false' },
      (({ draining: _, ...withoutDraining }) => withoutDraining)(HEALTH),
    ]) {
      expect(validateServeHealth(bad, '/tmp/project')).toBeNull();
    }
  });

  it('binds daemon identity and token posture to the discovery descriptor', () => {
    expect(validateServeHealth(HEALTH, '/tmp/project', HEALTHY)).toEqual(HEALTH);
    expect(validateServeHealth({ ...HEALTH, pid: 4243 }, '/tmp/project', HEALTHY)).toBeNull();
    expect(validateServeHealth(
      { ...HEALTH, tokenProtected: false },
      '/tmp/project',
      HEALTHY,
    )).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('accepts a filesystem alias of the same repository root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'openlore-health-root-'));
    const real = join(parent, 'real');
    const alias = join(parent, 'alias');
    await mkdir(real);
    await symlink(real, alias, 'dir');
    try {
      expect(validateServeHealth({ ...HEALTH, root: real }, alias)).not.toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('validateServeDescriptor', () => {
  it('accepts a well-formed loopback descriptor and round-trips its fields', () => {
    expect(validateServeDescriptor(HEALTHY)).toEqual(HEALTHY);
  });

  it('accepts every loopback host form', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '127.9.9.9']) {
      const d = validateServeDescriptor({ ...HEALTHY, host });
      expect(d, host).not.toBeNull();
      expect(d!.host).toBe(host);
    }
  });

  it('normalizes missing/ill-typed startedAt and version to empty strings', () => {
    const d = validateServeDescriptor({ port: 8080, pid: 1, host: '127.0.0.1' });
    expect(d).toEqual({ port: 8080, pid: 1, host: '127.0.0.1', token: undefined, startedAt: '', version: '' });
  });

  it('accepts an absent token but rejects a non-string one', () => {
    expect(validateServeDescriptor({ port: 8080, pid: 1, host: '127.0.0.1' })).not.toBeNull();
    expect(validateServeDescriptor({ port: 8080, pid: 1, host: '127.0.0.1', token: 5 })).toBeNull();
  });

  it('accepts only the ready/draining lifecycle states', () => {
    expect(validateServeDescriptor({ ...HEALTHY, state: 'ready' })?.state).toBe('ready');
    expect(validateServeDescriptor({ ...HEALTHY, state: 'draining' })?.state).toBe('draining');
    expect(validateServeDescriptor({ ...HEALTHY, state: 'starting' })).toBeNull();
  });

  it('rejects a non-loopback host (SSRF/egress guard)', () => {
    for (const host of ['169.254.169.254', 'evil.example.com', '0.0.0.0', '10.0.0.1', '', '128.0.0.1']) {
      expect(validateServeDescriptor({ ...HEALTHY, host }), host).toBeNull();
    }
  });

  it('rejects a bad port', () => {
    for (const port of ['8080', 70000, 0, -1, 8080.5, NaN]) {
      expect(validateServeDescriptor({ ...HEALTHY, port }), String(port)).toBeNull();
    }
  });

  it('rejects a bad pid', () => {
    for (const pid of [0, -1, 1.5, '1', NaN]) {
      expect(validateServeDescriptor({ ...HEALTHY, pid }), String(pid)).toBeNull();
    }
  });

  it('rejects a non-object, null, or array', () => {
    for (const v of [null, undefined, 42, 'str', [HEALTHY], []]) {
      expect(validateServeDescriptor(v), JSON.stringify(v)).toBeNull();
    }
  });
});

describe('readServeDescriptor', () => {
  let dir = '';
  const path = (): string => join(dir, '.openlore', 'serve.json');
  const write = async (raw: string): Promise<void> => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-desc-'));
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(path(), raw, 'utf-8');
  };

  it('returns null for a missing file', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'openlore-desc-'));
    try {
      expect(await readServeDescriptor(join(empty, '.openlore', 'serve.json'))).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('returns null for malformed JSON', async () => {
    await write('{ not json');
    try {
      expect(await readServeDescriptor(path())).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a poisoned (non-loopback) descriptor', async () => {
    await write(JSON.stringify({ port: 8080, pid: 1, host: '169.254.169.254' }));
    try {
      expect(await readServeDescriptor(path())).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns the validated descriptor for a healthy file', async () => {
    await write(JSON.stringify(HEALTHY));
    try {
      expect(await readServeDescriptor(path())).toEqual(HEALTHY);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hides draining daemons from normal clients while lifecycle owners can inspect them', async () => {
    const draining = { ...HEALTHY, state: 'draining' as const };
    await write(JSON.stringify(draining));
    try {
      expect(await readServeDescriptor(path())).toBeNull();
      expect(await readServeDescriptor(path(), { includeDraining: true })).toEqual(draining);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── No fourth door: every serve.json reader routes through the validator ───────

/** Recursively collect production .ts files (excluding tests) under `root`. */
function productionTsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...productionTsFiles(full));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.integration.test.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('serve.json reader coverage (mcp-security: ServeDescriptorValidatedAtEveryReader)', () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const validatorModule = fileURLToPath(new URL('./serve-descriptor.ts', import.meta.url));

  it('every production file referencing serve.json resolves it through readServeDescriptor', () => {
    const offenders: string[] = [];
    for (const file of productionTsFiles(srcRoot)) {
      if (file === validatorModule) continue; // the validator itself
      const src = readFileSync(file, 'utf-8');
      if (!src.includes('serve.json')) continue;
      // A reader is guarded iff it imports the shared validator. A file that
      // only writes/unlinks serve.json need not import it — but then it must
      // never read the file raw (the antipattern below).
      const guarded = src.includes('readServeDescriptor');
      const rawRead =
        /readFile\s*\([^;]*serve\.json/s.test(src) ||
        /\bas\s+ServeDescriptor\b/.test(src);
      if (!guarded && rawRead) offenders.push(file);
    }
    expect(offenders, `unguarded serve.json reader(s): ${offenders.join(', ')}`).toEqual([]);
  });

  it('the three known readers each import the shared validator', () => {
    const readers = [
      join(srcRoot, 'cli', 'commands', 'serve.ts'),
      join(srcRoot, 'core', 'services', 'serve-client.ts'),
      join(srcRoot, 'pi', 'extension.ts'),
    ];
    for (const reader of readers) {
      const src = readFileSync(reader, 'utf-8');
      expect(src.includes('readServeDescriptor'), `${reader} must route through readServeDescriptor`).toBe(true);
    }
  });
});
