/**
 * spec-store binding — config validation, name resolution against the federation
 * registry, and the read-only health check (change: add-spec-store-binding).
 *
 * Fixtures build a real home repo with a `.openlore/config.json` "specStore"
 * block and a federation registry whose target repos carry real
 * `fingerprint.json` files, so index state (indexed/stale/unindexed/missing) is
 * exercised through the actual registry, not a mock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleSpecStoreStatus,
  validateSpecStoreConfig,
} from './spec-store.js';
import { assertConclusionShape } from './tool-contract.js';
import { dispatchTool } from '../tool-dispatch.js';
import { addRepo, federationManifestPath } from '../../federation/registry.js';
import {
  OPENLORE_DIR,
  OPENLORE_CONFIG_FILENAME,
  OPENLORE_ANALYSIS_REL_PATH,
  ARTIFACT_FINGERPRINT,
} from '../../../constants.js';
import type { SpecStoreConfig } from '../../../types/index.js';

let home: string;
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'specstore-'));
  home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Write the home repo's `.openlore/config.json` with a specStore binding. */
function writeBinding(binding: SpecStoreConfig | undefined): void {
  mkdirSync(join(home, OPENLORE_DIR), { recursive: true });
  const config: Record<string, unknown> = {
    version: '1.0.0',
    projectType: 'unknown',
    openspecPath: 'openspec',
    analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
    generation: { model: 'x', domains: 'auto' },
    createdAt: new Date().toISOString(),
    lastRun: null,
  };
  if (binding) config.specStore = binding;
  writeFileSync(join(home, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME), JSON.stringify(config, null, 2));
}

/** Create a target repo dir and (optionally) write its index fingerprint. */
function makeRepo(name: string, fingerprint: string | null): string {
  const repoPath = join(scratch, name);
  mkdirSync(repoPath, { recursive: true });
  if (fingerprint !== null) {
    mkdirSync(join(repoPath, OPENLORE_ANALYSIS_REL_PATH), { recursive: true });
    writeFileSync(
      join(repoPath, OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_FINGERPRINT),
      JSON.stringify({ hash: fingerprint }),
    );
  }
  return repoPath;
}

/** Overwrite a repo's live fingerprint (to simulate drift after registration). */
function rewriteFingerprint(repoPath: string, fingerprint: string): void {
  writeFileSync(
    join(repoPath, OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_FINGERPRINT),
    JSON.stringify({ hash: fingerprint }),
  );
}

describe('validateSpecStoreConfig', () => {
  it('accepts a well-formed binding (no findings)', () => {
    const findings = validateSpecStoreConfig(
      { name: 'plans', path: join(scratch, 'plans'), targets: ['api', 'web'], references: ['design'] },
      home,
    );
    expect(findings).toEqual([]);
  });

  it('flags a duplicate target name', () => {
    const findings = validateSpecStoreConfig(
      { name: 'plans', path: join(scratch, 'plans'), targets: ['api', 'api'] },
      home,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('binding-invalid');
    expect(findings[0].subject).toBe('api');
  });

  it('flags an empty name and an empty path', () => {
    const findings = validateSpecStoreConfig(
      { name: '  ', path: '', targets: ['api'] },
      home,
    );
    expect(findings.every(f => f.code === 'binding-invalid')).toBe(true);
    expect(findings.map(f => f.subject)).toEqual(
      expect.arrayContaining(['specStore.name', 'specStore.path']),
    );
  });

  it('flags a self-referential store path (the home repo itself)', () => {
    const findings = validateSpecStoreConfig(
      { name: 'plans', path: home, targets: ['api'] },
      home,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('binding-invalid');
    expect(findings[0].message).toMatch(/itself/i);
  });
});

describe('handleSpecStoreStatus', () => {
  it('reports bound:false with a no-binding finding when nothing is configured', async () => {
    writeBinding(undefined);
    const report = await handleSpecStoreStatus(home);
    expect(report.bound).toBe(false);
    expect(report.provenance).toBe('local-unreviewed');
    expect(report.findings[0].provenance).toBe('local-unreviewed');
    expect(report.sound).toBe(true);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].code).toBe('no-binding');
  });

  it('a healthy binding reports zero findings and is sound', async () => {
    const api = makeRepo('api', 'hash-api');
    const web = makeRepo('web', 'hash-web');
    addRepo(home, api, { name: 'api' });
    addRepo(home, web, { name: 'web' });
    const store = makeRepo('plans', null); // store path just needs to exist
    writeBinding({ name: 'plans', path: store, targets: ['api', 'web'] });

    const report = await handleSpecStoreStatus(home);
    expect(report.bound).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.sound).toBe(true);
    expect(report.targets.every(t => t.resolved && t.state === 'indexed')).toBe(true);
  });

  it('an unresolved target yields exactly one target-unresolved finding; others still resolve', async () => {
    const api = makeRepo('api', 'hash-api');
    addRepo(home, api, { name: 'api' });
    const store = makeRepo('plans', null);
    // "web" is declared but never registered in the federation registry.
    writeBinding({ name: 'plans', path: store, targets: ['api', 'web'] });

    const report = await handleSpecStoreStatus(home);
    const unresolved = report.findings.filter(f => f.code === 'target-unresolved');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].subject).toBe('web');
    expect(report.targets.find(t => t.name === 'api')?.resolved).toBe(true);
    expect(report.sound).toBe(false); // an unresolved target is an error
  });

  it('a stale target index yields exactly one index-stale finding and does not block', async () => {
    const api = makeRepo('api', 'hash-v1');
    addRepo(home, api, { name: 'api' }); // registry captures hash-v1
    rewriteFingerprint(api, 'hash-v2'); // working tree drifts
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: ['api'] });

    const report = await handleSpecStoreStatus(home);
    const stale = report.findings.filter(f => f.code === 'index-stale');
    expect(stale).toHaveLength(1);
    expect(stale[0].severity).toBe('warn');
    expect(report.sound).toBe(true); // a warning does not make the binding unsound
  });

  it('an unindexed target yields an index-missing finding', async () => {
    const api = makeRepo('api', null); // dir exists, no fingerprint
    addRepo(home, api, { name: 'api' });
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: ['api'] });

    const report = await handleSpecStoreStatus(home);
    expect(report.findings.filter(f => f.code === 'index-missing')).toHaveLength(1);
  });

  // Regression (change: harden-federation-freshness): a target registered before
  // its first analyze (empty stored fingerprint) that later gains an index must be
  // disclosed as index-unbaselined, never implied a freshness-checked indexed.
  it('an unbaselined target yields exactly one index-unbaselined finding and does not block', async () => {
    const api = makeRepo('api', null); // registered with no index → empty fingerprint
    addRepo(home, api, { name: 'api' });
    // Index appears after registration (create the analysis dir, then the hash).
    mkdirSync(join(api, OPENLORE_ANALYSIS_REL_PATH), { recursive: true });
    rewriteFingerprint(api, 'hash-v1');
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: ['api'] });

    const report = await handleSpecStoreStatus(home);
    const unbaselined = report.findings.filter(f => f.code === 'index-unbaselined');
    expect(unbaselined).toHaveLength(1);
    expect(unbaselined[0].severity).toBe('warn');
    expect(report.findings.filter(f => f.code === 'index-stale')).toHaveLength(0);
    expect(report.targets.find(t => t.name === 'api')?.state).toBe('unbaselined');
    expect(report.sound).toBe(true); // a warning does not make the binding unsound
  });

  it('a missing reference yields exactly one reference-missing finding', async () => {
    const api = makeRepo('api', 'hash-api');
    addRepo(home, api, { name: 'api' });
    const store = makeRepo('plans', null);
    // "design" reference is not registered.
    writeBinding({ name: 'plans', path: store, targets: ['api'], references: ['design'] });

    const report = await handleSpecStoreStatus(home);
    const refMissing = report.findings.filter(f => f.code === 'reference-missing');
    expect(refMissing).toHaveLength(1);
    expect(refMissing[0].subject).toBe('design');
    expect(report.sound).toBe(true); // a missing reference is a warning, not blocking
  });

  it('a missing store path yields a store-path-missing finding', async () => {
    const api = makeRepo('api', 'hash-api');
    addRepo(home, api, { name: 'api' });
    writeBinding({ name: 'plans', path: join(scratch, 'does-not-exist'), targets: ['api'] });

    const report = await handleSpecStoreStatus(home);
    expect(report.findings.filter(f => f.code === 'store-path-missing')).toHaveLength(1);
    expect(report.sound).toBe(false);
  });

  it('every report satisfies the conclusion-over-graph contract', async () => {
    const api = makeRepo('api', 'hash-api');
    addRepo(home, api, { name: 'api' });
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: ['api', 'web'], references: ['design'] });

    const report = await handleSpecStoreStatus(home);
    expect(() => assertConclusionShape('spec_store_status', report)).not.toThrow();
  });
});

describe('handleSpecStoreStatus — adversarial / hardening', () => {
  // P1: the contract says infrastructure failures degrade to a finding, never throw.
  // loadRegistry throws on a corrupt/malformed manifest; the handler must catch it.
  it('does NOT throw on a corrupt federation.json — degrades to registry-unreadable', async () => {
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: ['api'] });
    mkdirSync(join(home, OPENLORE_DIR), { recursive: true });
    writeFileSync(federationManifestPath(home), '{ not valid json');

    let report: Awaited<ReturnType<typeof handleSpecStoreStatus>> | undefined;
    await expect((async () => { report = await handleSpecStoreStatus(home); })()).resolves.toBeUndefined();
    expect(report!.findings.some(f => f.code === 'registry-unreadable')).toBe(true);
    expect(report!.sound).toBe(false);
    // No misleading per-target cascade when the registry itself is the problem.
    expect(report!.findings.filter(f => f.code === 'target-unresolved')).toHaveLength(0);
    expect(report!.targets[0]).toMatchObject({ name: 'api', resolved: false });
    expect(() => assertConclusionShape('spec_store_status', report)).not.toThrow();
  });

  it('does NOT throw on a wrong-shape federation.json — degrades to registry-unreadable', async () => {
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: ['api'] });
    mkdirSync(join(home, OPENLORE_DIR), { recursive: true });
    writeFileSync(federationManifestPath(home), JSON.stringify({ repos: 'not-an-array' }));

    const report = await handleSpecStoreStatus(home);
    expect(report.findings.some(f => f.code === 'registry-unreadable')).toBe(true);
  });

  // P2a: a RELATIVE store path must resolve against the home repo, not process.cwd().
  it('detects a self-referential RELATIVE store path against the home dir, not cwd', () => {
    const findings = validateSpecStoreConfig(
      { name: 'plans', path: '.', targets: ['api'] },
      home,
    );
    expect(findings.some(f => f.code === 'binding-invalid' && /itself/i.test(f.message))).toBe(true);
  });

  // P2b: a name cannot be both a target and a reference.
  it('flags a name declared as both a target and a reference', async () => {
    const api = makeRepo('api', 'hash-api');
    addRepo(home, api, { name: 'api' });
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: ['api'], references: ['api'] });

    const report = await handleSpecStoreStatus(home);
    const crossListed = report.findings.filter(
      f => f.code === 'binding-invalid' && /both a target and a reference/i.test(f.message),
    );
    expect(crossListed).toHaveLength(1);
    expect(report.sound).toBe(false);
  });

  // P3: the echoed store name/path must match the trimmed values the checks used.
  it('echoes trimmed store name and path in the report', async () => {
    const store = makeRepo('plans', null);
    writeBinding({ name: '  plans  ', path: `  ${store}  `, targets: [] });

    const report = await handleSpecStoreStatus(home);
    expect(report.store?.name).toBe('plans');
    expect(report.store?.path).toBe(store);
  });

  // The MCP dispatch route is where the P1 throw actually escaped to an isError
  // result; dispatchTool must RESOLVE (not reject) with a corrupt registry.
  it('dispatchTool(spec_store_status) resolves to a report on a corrupt registry (no throw to the MCP layer)', async () => {
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: ['api'] });
    mkdirSync(join(home, OPENLORE_DIR), { recursive: true });
    writeFileSync(federationManifestPath(home), '{ not valid json');

    const result = await dispatchTool('spec_store_status', { directory: home }, home) as { bound: boolean; findings: Array<{ code: string }> };
    expect(result.bound).toBe(true);
    expect(result.findings.some(f => f.code === 'registry-unreadable')).toBe(true);
  });

  // Config arrives via raw JSON.parse — a wrong-typed field must NOT throw on .trim().
  it('does NOT throw on a non-string name/path — degrades to binding-invalid', async () => {
    writeBinding({ name: 123, path: 456, targets: ['api'] } as unknown as SpecStoreConfig);

    const report = await handleSpecStoreStatus(home);
    expect(report.findings.filter(f => f.code === 'binding-invalid').length).toBeGreaterThanOrEqual(2);
    expect(report.findings.some(f => /not a string/i.test(f.message))).toBe(true);
    expect(report.sound).toBe(false);
    expect(() => assertConclusionShape('spec_store_status', report)).not.toThrow();
  });

  it('does NOT throw on non-string entries in targets — flags binding-invalid and drops them from resolution', async () => {
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: [1, 2] } as unknown as SpecStoreConfig);

    const report = await handleSpecStoreStatus(home);
    expect(report.findings.some(f => f.code === 'binding-invalid' && /non-string/i.test(f.message))).toBe(true);
    // The numeric entries are not resolved as targets (no numeric target-unresolved cascade).
    expect(report.findings.filter(f => f.code === 'target-unresolved')).toHaveLength(0);
    expect(report.targets).toHaveLength(0);
  });

  it('does NOT throw when specStore itself is not an object', async () => {
    writeBinding('not-an-object' as unknown as SpecStoreConfig);
    const report = await handleSpecStoreStatus(home);
    // A primitive specStore has no name/path -> binding-invalid, but never throws.
    expect(report.bound).toBe(true);
    expect(() => assertConclusionShape('spec_store_status', report)).not.toThrow();
  });
});
