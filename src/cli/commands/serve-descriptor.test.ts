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
  canonicalServeRoot,
  SERVE_PROTOCOL_VERSION,
} from './serve-descriptor.js';

// The health root is a filesystem identity, not a string: validateServeHealth compares and
// PROJECTS it through canonicalServeRoot (resolve + realpath, lower-cased on Windows). A
// POSIX literal is therefore not the value that comes back on Windows — `/tmp/project`
// resolves to `c:\tmp\project` there — and the round-trip assertions below would fail on a
// difference the validator is supposed to erase. Canonicalising the FIXTURE once keeps the
// projection an identity on every platform, without relaxing any comparison.
const ROOT = canonicalServeRoot('/tmp/project');
const OTHER_ROOT = canonicalServeRoot('/tmp/other');

const HEALTHY = { port: 8080, pid: 4242, host: '127.0.0.1', token: 't', protocolVersion: SERVE_PROTOCOL_VERSION, startedAt: 's', version: 'v' } as const;
const HEALTH = {
  ok: true,
  protocolVersion: SERVE_PROTOCOL_VERSION,
  presetDispatchEnforced: true,
  root: ROOT,
  pid: 4242,
  preset: 'full',
  tools: ['orient'],
  tokenProtected: true,
  tokenAuthenticated: true,
  draining: false,
};

describe('optional watcher field (change: extend-api-for-supervising-hosts)', () => {
  it('projects a valid watcher value through', () => {
    const health = validateServeHealth({ ...HEALTH, watcher: 'stopped' }, ROOT);
    expect(health?.watcher).toBe('stopped');
  });

  it('validates a payload that omits watcher, and reports it absent rather than guessing', () => {
    const health = validateServeHealth(HEALTH, ROOT);
    expect(health).not.toBeNull();
    expect(health?.watcher).toBeUndefined();
  });

  it('drops an ill-typed watcher instead of passing it through', () => {
    const health = validateServeHealth({ ...HEALTH, watcher: 'sort-of-ok' }, ROOT);
    expect(health).not.toBeNull(); // an advisory field must not make a valid daemon unreadable
    expect(health?.watcher).toBeUndefined();
  });

  it('did not tighten or loosen any security-critical field', () => {
    expect(validateServeHealth({ ...HEALTH, tokenAuthenticated: false }, ROOT)).toBeNull();
    expect(validateServeHealth({ ...HEALTH, root: OTHER_ROOT }, ROOT)).toBeNull();
    expect(validateServeHealth({ ...HEALTH, protocolVersion: 999 }, ROOT)).toBeNull();
  });
});

it('formats IPv4 and IPv6 loopback origins safely', () => {
  expect(serveHttpBaseUrl('127.0.0.1', 8080)).toBe('http://127.0.0.1:8080');
  expect(serveHttpBaseUrl('::1', 8080)).toBe('http://[::1]:8080');
});

describe('validateServeHealth', () => {
  it('requires an authenticated enforced surface bound to the expected root', () => {
    expect(validateServeHealth(HEALTH, ROOT)).toEqual(HEALTH);
    for (const bad of [
      { ...HEALTH, presetDispatchEnforced: false },
      { ...HEALTH, root: OTHER_ROOT },
      { ...HEALTH, pid: 0 },
      { ...HEALTH, tools: [1] },
      { ...HEALTH, tokenProtected: 'yes' },
      { ...HEALTH, tokenAuthenticated: false },
      { ...HEALTH, draining: 'false' },
      (({ draining: _, ...withoutDraining }) => withoutDraining)(HEALTH),
    ]) {
      expect(validateServeHealth(bad, ROOT)).toBeNull();
    }
  });

  it('binds daemon identity and token posture to the discovery descriptor', () => {
    expect(validateServeHealth(HEALTH, ROOT, HEALTHY)).toEqual(HEALTH);
    expect(validateServeHealth({ ...HEALTH, pid: 4243 }, ROOT, HEALTHY)).toBeNull();
    expect(validateServeHealth(
      { ...HEALTH, tokenProtected: false },
      ROOT,
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
    const d = validateServeDescriptor({ port: 8080, pid: 1, host: '127.0.0.1', protocolVersion: SERVE_PROTOCOL_VERSION });
    expect(d).toEqual({ port: 8080, pid: 1, host: '127.0.0.1', token: undefined, protocolVersion: SERVE_PROTOCOL_VERSION, startedAt: '', version: '' });
  });

  it('accepts an absent token but rejects a non-string one', () => {
    expect(validateServeDescriptor({ port: 8080, pid: 1, host: '127.0.0.1', protocolVersion: SERVE_PROTOCOL_VERSION })).not.toBeNull();
    expect(validateServeDescriptor({ port: 8080, pid: 1, host: '127.0.0.1', protocolVersion: SERVE_PROTOCOL_VERSION, token: 5 })).toBeNull();
  });

  it('rejects legacy or incompatible daemon protocols', () => {
    expect(validateServeDescriptor({ ...HEALTHY, protocolVersion: undefined })).toBeNull();
    expect(validateServeDescriptor({ ...HEALTHY, protocolVersion: SERVE_PROTOCOL_VERSION + 1 })).toBeNull();
    expect(validateServeHealth({ ...HEALTH, protocolVersion: SERVE_PROTOCOL_VERSION + 1 }, ROOT, HEALTHY)).toBeNull();
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

  // An embedding host that discovers a daemon is a FOURTH reader, one package boundary away
  // (change: extend-api-for-supervising-hosts). It cannot be made to import the validator by a
  // source guard — it is not our source. The only lever we have is to publish the validator, so
  // the host's cheapest path is to share ours instead of copying it. These pin that lever.
  it('the published subpath exposes the validator to an embedding host', () => {
    const entry = join(srcRoot, 'api', 'serve-descriptor.ts');
    const src = readFileSync(entry, 'utf-8');
    for (const name of [
      'readServeDescriptor',
      'readServeDescriptorState',
      'validateServeDescriptor',
      'validateServeHealth',
      'serveHttpBaseUrl',
      'canonicalServeRoot',
      'SERVE_PROTOCOL_VERSION',
    ]) {
      expect(src.includes(name), `${entry} must re-export ${name} for embedding hosts`).toBe(true);
    }
    // It must expose OUR validator, not a reimplementation of it.
    expect(src.includes("from '../cli/commands/serve-descriptor.js'")).toBe(true);
  });

  it('package.json publishes the subpath, so the validator is reachable outside the package', () => {
    const pkg = JSON.parse(readFileSync(join(srcRoot, '..', 'package.json'), 'utf-8')) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };
    const subpath = pkg.exports?.['./serve-descriptor'];
    expect(subpath?.import, 'exports must publish ./serve-descriptor').toBe('./dist/api/serve-descriptor.js');
    expect(subpath?.types).toBe('./dist/api/serve-descriptor.d.ts');
  });
});
