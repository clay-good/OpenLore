/**
 * An explicit global `--config <path>` is honored: config reads/writes/exists for
 * the primary root resolve to that file, while peer (federation / spec-store) reads
 * of other repositories are never redirected (ExplicitConfigPathIsHonored, change:
 * wire-global-config-path).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  resolveOpenLoreConfigPath,
  setPrimaryConfigPath,
  clearPrimaryConfigPath,
  readOpenLoreConfig,
  writeOpenLoreConfig,
  openloreConfigExists,
} from './config-manager.js';
import { OPENLORE_DIR, OPENLORE_CONFIG_FILENAME } from '../../constants.js';
import { getDefaultConfig } from './config-manager.js';

let root: string;
let peer: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ol-cfg-root-'));
  peer = await mkdtemp(join(tmpdir(), 'ol-cfg-peer-'));
});

afterEach(async () => {
  clearPrimaryConfigPath();
  await rm(root, { recursive: true, force: true });
  await rm(peer, { recursive: true, force: true });
});

const defaultPath = (r: string) => join(r, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME);

describe('resolveOpenLoreConfigPath', () => {
  it('returns the default path when no override is set', () => {
    expect(resolveOpenLoreConfigPath(root)).toBe(defaultPath(root));
  });

  it('returns the override for the primary root, resolved to absolute', () => {
    const custom = join(root, 'custom', 'my.json');
    setPrimaryConfigPath(root, custom);
    expect(resolveOpenLoreConfigPath(root)).toBe(resolve(custom));
  });

  it('matches the root regardless of how it is spelled', () => {
    const custom = join(root, 'my.json');
    setPrimaryConfigPath(root, custom);
    // A trailing-slash / unresolved spelling of the same root still matches.
    expect(resolveOpenLoreConfigPath(root + '/')).toBe(resolve(custom));
  });

  it('never redirects a peer root (federation / spec-store safety)', () => {
    setPrimaryConfigPath(root, join(root, 'my.json'));
    expect(resolveOpenLoreConfigPath(peer)).toBe(defaultPath(peer));
  });

  it('clearPrimaryConfigPath restores default resolution', () => {
    setPrimaryConfigPath(root, join(root, 'my.json'));
    clearPrimaryConfigPath();
    expect(resolveOpenLoreConfigPath(root)).toBe(defaultPath(root));
  });
});

describe('read/write/exists honor the override', () => {
  it('readOpenLoreConfig reads the explicit path, not the default', async () => {
    const custom = join(root, 'elsewhere.json');
    await writeFile(custom, JSON.stringify({ ...getDefaultConfig('nodejs', './openspec'), projectType: 'python' }));
    // The default location is absent — proving the read came from the override.
    setPrimaryConfigPath(root, custom);
    const cfg = await readOpenLoreConfig(root);
    expect(cfg?.projectType).toBe('python');
  });

  it('openloreConfigExists reflects the override target', async () => {
    const custom = join(root, 'elsewhere.json');
    setPrimaryConfigPath(root, custom);
    expect(await openloreConfigExists(root)).toBe(false);
    await writeFile(custom, '{}');
    expect(await openloreConfigExists(root)).toBe(true);
  });

  it('writeOpenLoreConfig writes to the override path (creating parent dirs)', async () => {
    const custom = join(root, 'nested', 'dir', 'cfg.json');
    setPrimaryConfigPath(root, custom);
    await writeOpenLoreConfig(root, getDefaultConfig('go', './openspec'));
    // Round-trips through the override, and the default path was never written.
    const back = await readOpenLoreConfig(root);
    expect(back?.projectType).toBe('go');
    expect(await openloreConfigExists(peer)).toBe(false);
  });

  it('a peer read still sees the peer default while an override is active', async () => {
    await mkdir(join(peer, OPENLORE_DIR), { recursive: true });
    await writeFile(defaultPath(peer), JSON.stringify(getDefaultConfig('ruby', './openspec')));
    setPrimaryConfigPath(root, join(root, 'override.json'));
    const peerCfg = await readOpenLoreConfig(peer);
    expect(peerCfg?.projectType).toBe('ruby');
  });
});
