/**
 * Tests for the feature inventory (change: refine-happy-path-and-defaults /
 * ZeroConfigWithGuidedActivation). Verifies that every opt-in feature's active /
 * inactive state is detected deterministically from config + on-disk markers, that
 * the zero-required-config baseline is reported, and that detection is fail-soft.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectFeatureInventory, type FeatureStatus } from './feature-inventory.js';

function byId(features: FeatureStatus[], id: string): FeatureStatus {
  const f = features.find((x) => x.id === id);
  if (!f) throw new Error(`feature ${id} not found`);
  return f;
}

const BASE_CONFIG = {
  version: '1.0.0',
  projectType: 'nodejs',
  openspecPath: 'openspec',
  analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
  generation: { model: 'claude-sonnet-4-6', domains: 'auto' },
  createdAt: '2026-06-28T00:00:00Z',
  lastRun: null,
};

describe('feature-inventory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `openlore-feat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(extra: Record<string, unknown>): Promise<void> {
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(
      join(dir, '.openlore', 'config.json'),
      JSON.stringify({ ...BASE_CONFIG, ...extra }, null, 2)
    );
  }

  it('reports zero-config baseline and configFound=false on a bare dir', async () => {
    const inv = await collectFeatureInventory(dir);
    expect(inv.configFound).toBe(false);
    expect(inv.requiredConfigKeys).toBe(0);
    // Every opt-in feature is inactive on a bare dir.
    expect(inv.activeCount).toBe(0);
    expect(inv.optInCount).toBeGreaterThan(0);
    expect(inv.features.every((f) => (f.optIn ? f.state === 'inactive' : true))).toBe(true);
  });

  it('every opt-in feature exposes an activation hint when inactive', async () => {
    const inv = await collectFeatureInventory(dir);
    for (const f of inv.features.filter((x) => x.optIn && x.state === 'inactive')) {
      expect(f.activate.length).toBeGreaterThan(0);
    }
  });

  it('detects semantic embeddings (local) as active', async () => {
    await writeConfig({ embedding: { provider: 'local' } });
    const inv = await collectFeatureInventory(dir);
    const emb = byId(inv.features, 'semantic-embeddings');
    expect(emb.state).toBe('active');
    expect(emb.detail).toMatch(/on-device/);
    expect(emb.activate).toBe('');
  });

  it('detects remote embeddings only when baseUrl AND model are present', async () => {
    await writeConfig({ embedding: { baseUrl: 'https://e.example/v1' } }); // no model
    let inv = await collectFeatureInventory(dir);
    expect(byId(inv.features, 'semantic-embeddings').state).toBe('inactive');

    await writeConfig({ embedding: { baseUrl: 'https://e.example/v1', model: 'm' } });
    inv = await collectFeatureInventory(dir);
    expect(byId(inv.features, 'semantic-embeddings').state).toBe('active');
  });

  it('treats task-scoped context injection as default-on, and inactive only when off', async () => {
    let inv = await collectFeatureInventory(dir);
    const ctx = byId(inv.features, 'context-injection');
    expect(ctx.state).toBe('default-on');
    expect(ctx.optIn).toBe(false); // does not count toward opt-in active total

    await writeConfig({ contextInjection: { mode: 'off' } });
    inv = await collectFeatureInventory(dir);
    expect(byId(inv.features, 'context-injection').state).toBe('inactive');
  });

  it('detects the wired MCP preset from .mcp.json', async () => {
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { openlore: { command: 'npx', args: ['--yes', 'openlore', 'mcp', '--preset', 'substrate'] } },
      })
    );
    const inv = await collectFeatureInventory(dir);
    const mcp = byId(inv.features, 'mcp-tool-preset');
    expect(mcp.state).toBe('active');
    expect(mcp.detail).toMatch(/substrate/);
  });

  it('falls back to the lean default preset when wired with no explicit --preset', async () => {
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { openlore: { command: 'npx', args: ['--yes', 'openlore', 'mcp'] } } })
    );
    const inv = await collectFeatureInventory(dir);
    expect(byId(inv.features, 'mcp-tool-preset').detail).toMatch(/substrate/);
  });

  it('detects architecture invariants from .openlore/architecture.json', async () => {
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(join(dir, '.openlore', 'architecture.json'), '{}');
    const inv = await collectFeatureInventory(dir);
    expect(byId(inv.features, 'architecture-invariants').state).toBe('active');
  });

  it('detects impact-certificate surfaces and reports blocking count', async () => {
    await writeConfig({
      impactCertificate: {
        surfaces: [{ name: 'client', members: [{ file: 'src/x.ts' }] }],
        block: ['critical'],
      },
    });
    const inv = await collectFeatureInventory(dir);
    const ic = byId(inv.features, 'impact-certificate');
    expect(ic.state).toBe('active');
    expect(ic.detail).toMatch(/1 covering surface/);
    expect(ic.detail).toMatch(/1 blocking/);
  });

  it('detects enforcement policy and counts blocking codes', async () => {
    await writeConfig({
      enforcement: { policy: { 'stale-decision-reference': 'blocking', 'footprint-escape': 'advisory' } },
    });
    const inv = await collectFeatureInventory(dir);
    const ep = byId(inv.features, 'enforcement-policy');
    expect(ep.state).toBe('active');
    expect(ep.detail).toMatch(/2 finding code/);
    expect(ep.detail).toMatch(/1 blocking/);
  });

  it('detects frozen enforcement codes without calling them advisory', async () => {
    await writeConfig({ enforcement: { policy: { 'stale-decision-reference': 'frozen' } } });
    const ep = byId((await collectFeatureInventory(dir)).features, 'enforcement-policy');
    expect(ep.detail).toMatch(/1 frozen/);
    expect(ep.detail).not.toMatch(/all advisory/);
  });

  it('advertises both immediate blocking and frozen ratchet activation', async () => {
    const ep = byId((await collectFeatureInventory(dir)).features, 'enforcement-policy');
    expect(ep.activate).toMatch(/"blocking" or "frozen"/);
  });

  it('detects blast-radius blocking patterns', async () => {
    await writeConfig({ blastRadius: { block: ['orphans-anchored-decision'] } });
    const inv = await collectFeatureInventory(dir);
    expect(byId(inv.features, 'blast-radius-block').state).toBe('active');
  });

  it('detects an installed OpenLore commit-gate hook (and ignores a non-OpenLore one)', async () => {
    await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
    await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho lint\n');
    let inv = await collectFeatureInventory(dir);
    expect(byId(inv.features, 'commit-gate-hook').state).toBe('inactive');

    await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nopenlore enforce --hook\n');
    inv = await collectFeatureInventory(dir);
    expect(byId(inv.features, 'commit-gate-hook').state).toBe('active');
  });

  it('detects panic governance only when mode is not off', async () => {
    await writeConfig({ panicResponse: { mode: 'off' } });
    let inv = await collectFeatureInventory(dir);
    expect(byId(inv.features, 'panic-response').state).toBe('inactive');

    await writeConfig({ panicResponse: { mode: 'observe' } });
    inv = await collectFeatureInventory(dir);
    const panic = byId(inv.features, 'panic-response');
    expect(panic.state).toBe('active');
    expect(panic.detail).toMatch(/observe/);
  });

  it('detects spec-store binding with target count', async () => {
    await writeConfig({ specStore: { name: 'specs', path: '~/s', targets: ['lib', 'pay'] } });
    const inv = await collectFeatureInventory(dir);
    const ss = byId(inv.features, 'spec-store');
    expect(ss.state).toBe('active');
    expect(ss.detail).toMatch(/2 target/);
  });

  it('reports federation active when its peers are reachable', async () => {
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await mkdir(join(dir, 'peer-a'), { recursive: true });
    await mkdir(join(dir, 'peer-b'), { recursive: true });
    await writeFile(
      join(dir, '.openlore', 'federation.json'),
      JSON.stringify({ schemaVersion: 1, repos: [
        { name: 'a', path: join(dir, 'peer-a') },
        { name: 'b', path: join(dir, 'peer-b') },
      ] })
    );
    const inv = await collectFeatureInventory(dir);
    const fed = byId(inv.features, 'federation');
    expect(fed.state).toBe('active');
    expect(fed.detail).toMatch(/2 peer/);
    expect(fed.detail).toMatch(/reachable/);
  });

  it('reports federation as degraded (not active ✓) when its peers are unreachable (finding #4)', async () => {
    // The old inventory counted registry ROWS as health, so a registry of missing peers
    // showed as active ✓ while `federation list` reported every one "✗ missing path".
    // Health now reflects resolvability: all-unreachable is inactive, and says why.
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(
      join(dir, '.openlore', 'federation.json'),
      JSON.stringify({ schemaVersion: 1, repos: [
        { name: 'a', path: join(dir, 'no-such-peer-a') },
        { name: 'b', path: join(dir, 'no-such-peer-b') },
      ] })
    );
    const inv = await collectFeatureInventory(dir);
    const fed = byId(inv.features, 'federation');
    expect(fed.state).toBe('inactive');
    expect(fed.detail).toMatch(/2 peer.*unreachable/i);
  });

  it('is fail-soft: malformed marker files degrade to inactive, never throw', async () => {
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(join(dir, '.mcp.json'), '{ not valid json');
    await writeFile(join(dir, '.openlore', 'federation.json'), 'also not json');
    const inv = await collectFeatureInventory(dir);
    expect(byId(inv.features, 'mcp-tool-preset').state).toBe('inactive');
    expect(byId(inv.features, 'federation').state).toBe('inactive');
  });

  it('counts active opt-in features correctly with a fully-loaded config', async () => {
    await writeConfig({
      embedding: { provider: 'local' },
      blastRadius: { block: ['orphans-anchored-decision'] },
      impactCertificate: { surfaces: [{ name: 'c', members: [] }] },
      enforcement: { policy: { x: 'blocking' } },
      panicResponse: { mode: 'advisory' },
      specStore: { name: 's', path: '~/s', targets: [] },
      governance: { autopilot: true },
    });
    await writeFile(join(dir, '.openlore', 'architecture.json'), '{}');
    await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
    await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), 'openlore enforce --hook');
    await mkdir(join(dir, 'peer-a'), { recursive: true });
    await writeFile(
      join(dir, '.openlore', 'federation.json'),
      JSON.stringify({ repos: [{ name: 'a', path: join(dir, 'peer-a') }] })
    );
    const inv = await collectFeatureInventory(dir);
    // 10 opt-in features, all active (decision autopilot added the 10th).
    expect(inv.activeCount).toBe(10);
    expect(inv.optInCount).toBe(10);
  });
});
