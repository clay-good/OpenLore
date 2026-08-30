/**
 * Tests for config-schema — deterministic validation of `.openlore/config.json`
 * (change: add-config-schema-validation).
 */

import { describe, it, expect } from 'vitest';
import type { OpenLoreConfig } from '../../types/index.js';
import {
  validateOpenLoreConfig,
  checkConfigVersion,
  CONFIG_FIELD_KINDS,
  KNOWN_CONFIG_KEYS,
  CONFIG_SCHEMA_VERSION,
  backfillRequiredConfigDefaults,
  findCompatibilityFieldsWithoutDefaults,
  findRequiredFieldsWithoutDefaults,
  type ConfigMigration,
} from './config-schema.js';
import { getDefaultConfig } from './config-manager.js';

/**
 * A fully-populated config typed `Required<OpenLoreConfig>` — TypeScript forces every
 * optional key present, so adding a field to `OpenLoreConfig` breaks this literal until
 * it is listed here AND in `CONFIG_FIELD_KINDS`. The runtime assertion below names any
 * residual divergence between the two. This is the type-completeness bind.
 */
const FULLY_POPULATED: Required<OpenLoreConfig> = {
  version: CONFIG_SCHEMA_VERSION,
  projectType: 'nodejs',
  openspecPath: 'openspec',
  analysis: { maxFiles: 1, includePatterns: [], excludePatterns: [] },
  generation: { domains: 'auto' },
  llm: {},
  embedding: {},
  retrieval: {},
  panicResponse: { mode: 'off' },
  createdAt: '2026-07-18T00:00:00.000Z',
  lastRun: null,
  blastRadius: {},
  specStore: { name: 's', path: '/tmp/s', targets: [] },
  governance: {},
  impactCertificate: {},
  contextInjection: {},
  enforcement: {},
  secretRedaction: {},
  bundle: {},
  workspace: { shards: [{ name: 'api', root: 'packages/api' }] },
};

describe('config-schema — type-completeness bind', () => {
  it('signals the workspace schema addition with schema version 1.2.0', () => {
    expect(CONFIG_SCHEMA_VERSION).toBe('1.2.0');
    expect(checkConfigVersion('1.0.0')).toEqual([]);
  });

  it('rejects duplicate and reserved workspace shard names', () => {
    const findings = validateOpenLoreConfig({
      ...FULLY_POPULATED,
      workspace: { shards: [
        { name: 'root', root: 'packages/root' },
        { name: 'api', root: 'packages/api' },
        { name: 'api', root: 'packages/api-copy' },
      ] },
    });
    expect(findings.filter(finding => finding.key?.endsWith('.name'))).toHaveLength(2);
    expect(findings.every(finding => finding.fatal === true)).toBe(true);
  });

  it('validator field map covers exactly the keys of a fully-populated OpenLoreConfig', () => {
    const typeKeys = Object.keys(FULLY_POPULATED).sort();
    const validatorKeys = [...KNOWN_CONFIG_KEYS].sort();
    // Names any field bound in one place but not the other.
    expect(validatorKeys).toEqual(typeKeys);
  });

  it('every validator kind is a recognized shape', () => {
    for (const kind of Object.values(CONFIG_FIELD_KINDS)) {
      expect(['string', 'string-or-null', 'object']).toContain(kind);
    }
  });

  it('a fully-populated, correctly-typed config yields zero findings', () => {
    expect(validateOpenLoreConfig(FULLY_POPULATED)).toEqual([]);
  });

  it('rejects absolute workspace shard roots at config validation', () => {
    const findings = validateOpenLoreConfig({
      ...FULLY_POPULATED,
      workspace: { shards: [{ name: 'api', root: '/repo/packages/api' }] },
    });
    expect(findings).toContainEqual(expect.objectContaining({
      key: 'workspace.shards[0].root', fatal: true,
    }));
  });

  it('rejects control characters in workspace shard names', () => {
    const findings = validateOpenLoreConfig({
      ...FULLY_POPULATED,
      workspace: { shards: [{ name: 'bad\nname', root: 'packages/api' }] },
    });
    expect(findings).toContainEqual(expect.objectContaining({
      key: 'workspace.shards[0].name', fatal: true,
    }));
  });

  it('rejects C1 terminal controls in workspace shard names', () => {
    const findings = validateOpenLoreConfig({
      ...FULLY_POPULATED,
      workspace: { shards: [{ name: 'bad\u009b31m', root: 'packages/api' }] },
    });
    expect(findings).toContainEqual(expect.objectContaining({
      key: 'workspace.shards[0].name', fatal: true,
    }));
  });

  it('accepts frozen as a categorical enforcement policy class', () => {
    expect(validateOpenLoreConfig({
      ...FULLY_POPULATED,
      enforcement: { policy: { 'stale-decision-reference': 'frozen' } },
    })).toEqual([]);
  });

  it('canonical default sections populate every field the schema requires', () => {
    const defaults = getDefaultConfig('nodejs', 'openspec');
    expect(findRequiredFieldsWithoutDefaults(defaults)).toEqual([]);
    expect(findCompatibilityFieldsWithoutDefaults(defaults)).toEqual([]);
  });

  it('detects an upgrade-safe field missing from the canonical defaults', () => {
    const defaults = getDefaultConfig('nodejs', 'openspec');
    delete (defaults.generation as Partial<typeof defaults.generation>).domains;

    expect(findRequiredFieldsWithoutDefaults(defaults)).toContain('generation.domains');
    expect(findCompatibilityFieldsWithoutDefaults(defaults)).toEqual(['generation.domains']);
  });

  it('backfills only missing required values inside existing default sections', () => {
    const defaults = {
      ...FULLY_POPULATED,
      analysis: { maxFiles: 100_000, includePatterns: [], excludePatterns: [] },
      generation: { model: 'default-model', domains: 'auto' },
    };
    const parsed = {
      ...FULLY_POPULATED,
      analysis: { maxFiles: 25, includePatterns: [], excludePatterns: ['dist/**'] },
      generation: { model: 'custom-model' },
    };

    const result = backfillRequiredConfigDefaults(parsed, defaults);

    expect(result.config).toMatchObject({
      analysis: { maxFiles: 25, excludePatterns: ['dist/**'] },
      generation: { model: 'custom-model', domains: 'auto' },
    });
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: 'default-added', key: 'generation.domains', fatal: false }),
    ]);
    expect(parsed.generation).not.toHaveProperty('domains');
  });

  it('does not repair missing legacy-required fields in a truncated strict section', () => {
    const defaults = getDefaultConfig('nodejs', 'openspec');
    const parsed = {
      ...defaults,
      analysis: {},
      generation: {},
    };

    const result = backfillRequiredConfigDefaults(parsed, defaults);

    expect(result.config).toMatchObject({ analysis: {}, generation: { domains: 'auto' } });
    expect(result.findings.map(finding => finding.key)).toEqual(['generation.domains']);
    expect(validateOpenLoreConfig(result.config)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'missing-required', key: 'analysis.maxFiles', fatal: true }),
      expect.objectContaining({ kind: 'missing-required', key: 'analysis.includePatterns', fatal: true }),
      expect.objectContaining({ kind: 'missing-required', key: 'analysis.excludePatterns', fatal: true }),
    ]));
  });

  it('requires every non-optional top-level config field', () => {
    const findings = validateOpenLoreConfig({});

    expect(findings.filter(f => f.kind === 'missing-required').map(f => f.key)).toEqual([
      'version',
      'projectType',
      'openspecPath',
      'analysis',
      'generation',
      'createdAt',
      'lastRun',
    ]);
    expect(findings.every(f => f.message.includes("re-run 'openlore init'"))).toBe(true);
    expect(findings.every(f => f.fatal === true)).toBe(true);
  });

  it('does not require optional sections', () => {
    const minimal = {
      version: CONFIG_SCHEMA_VERSION,
      projectType: 'nodejs',
      openspecPath: 'openspec',
      analysis: { maxFiles: 1, includePatterns: [], excludePatterns: [] },
      generation: { domains: 'auto' },
      createdAt: '2026-07-18T00:00:00.000Z',
      lastRun: null,
    };

    expect(validateOpenLoreConfig(minimal)).toEqual([]);
  });
});

describe('config-schema — unknown keys', () => {
  it('discloses a typo with a did-you-mean suggestion', () => {
    const findings = validateOpenLoreConfig({
      ...FULLY_POPULATED,
      pancResponse: { mode: 'off' },
    });
    const f = findings.find(x => x.key === 'pancResponse');
    expect(f).toBeDefined();
    expect(f?.kind).toBe('unknown-key');
    expect(f?.suggestion).toBe('panicResponse');
    expect(f?.message).toContain('panicResponse');
  });

  it('suggests the nearest known key for a misspelled section', () => {
    const findings = validateOpenLoreConfig({ ...FULLY_POPULATED, embeding: {} });
    const f = findings.find(x => x.key === 'embeding');
    expect(f?.suggestion).toBe('embedding');
  });

  it('discloses a far-off unknown key as possibly-newer, with no suggestion', () => {
    const findings = validateOpenLoreConfig({
      ...FULLY_POPULATED,
      somethingFromTheFuture: { nested: true },
    });
    const f = findings.find(x => x.key === 'somethingFromTheFuture');
    expect(f).toBeDefined();
    expect(f?.suggestion).toBeUndefined();
    expect(f?.message).toContain('newer OpenLore');
  });

  it('a config using only known keys is silent', () => {
    expect(validateOpenLoreConfig(FULLY_POPULATED)).toEqual([]);
  });
});

describe('config-schema — type mismatches', () => {
  it('flags a string field holding an object', () => {
    const findings = validateOpenLoreConfig({ ...FULLY_POPULATED, version: { major: 1 } });
    const f = findings.find(x => x.key === 'version');
    expect(f?.kind).toBe('type-mismatch');
    expect(f?.message).toContain('should be a string');
  });

  it('flags an object field holding a string', () => {
    const findings = validateOpenLoreConfig({ ...FULLY_POPULATED, analysis: 'nope' });
    const f = findings.find(x => x.key === 'analysis');
    expect(f?.kind).toBe('type-mismatch');
    expect(f?.message).toContain('should be an object');
  });

  it('flags an object field holding an array (arrays are not objects here)', () => {
    const findings = validateOpenLoreConfig({ ...FULLY_POPULATED, generation: [] });
    const f = findings.find(x => x.key === 'generation');
    expect(f?.kind).toBe('type-mismatch');
    expect(f?.message).toContain('got array');
  });

  it('accepts lastRun as null and as a string', () => {
    expect(validateOpenLoreConfig({ ...FULLY_POPULATED, lastRun: null })).toEqual([]);
    expect(validateOpenLoreConfig({ ...FULLY_POPULATED, lastRun: '2026-01-01' })).toEqual([]);
  });

  it('validates trusted bundle signer entries', () => {
    expect(validateOpenLoreConfig({
      ...FULLY_POPULATED,
      bundle: { trustedSigners: [{ publicKey: '-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----', label: 'release' }] },
    })).toEqual([]);

    const findings = validateOpenLoreConfig({
      ...FULLY_POPULATED,
      bundle: { trustedSigners: [{ label: 'missing key' }] },
    });
    expect(findings.some(f => f.key === 'bundle.trustedSigners[0].publicKey' && f.fatal)).toBe(true);
  });

  it('flags lastRun holding a number', () => {
    const findings = validateOpenLoreConfig({ ...FULLY_POPULATED, lastRun: 123 });
    const f = findings.find(x => x.key === 'lastRun');
    expect(f?.kind).toBe('type-mismatch');
    expect(f?.message).toContain('a string or null');
  });

  it('flags a wrong nested scalar type with its full key path', () => {
    const findings = validateOpenLoreConfig({
      ...FULLY_POPULATED,
      analysis: { ...FULLY_POPULATED.analysis, maxFiles: 'lots' },
    });
    const f = findings.find(x => x.key === 'analysis.maxFiles');

    expect(f?.kind).toBe('type-mismatch');
    expect(f?.message).toContain('should be a number');
    expect(f?.message).toContain('got string');
    expect(f?.fatal).toBe(true);
  });

  it('validates declared fields in optional nested sections', () => {
    const findings = validateOpenLoreConfig({
      ...FULLY_POPULATED,
      embedding: { provider: 'remote', batchSize: 'many' },
      retrieval: { vocabularyExpansion: 'yes' },
      contextInjection: { tokenBudget: false },
      secretRedaction: { toolOutput: 'yes' },
    });

    expect(findings.filter(f => f.kind === 'type-mismatch').map(f => f.key)).toEqual([
      'embedding.batchSize',
      'retrieval.vocabularyExpansion',
      'contextInjection.tokenBudget',
      'secretRedaction.toolOutput',
    ]);
    expect(findings.every(f => f.fatal === false)).toBe(true);
  });

  it('requires declared nested fields when their section is present', () => {
    const findings = validateOpenLoreConfig({
      ...FULLY_POPULATED,
      analysis: {},
      generation: {},
      specStore: {},
    });

    expect(findings.filter(f => f.kind === 'missing-required').map(f => f.key)).toEqual([
      'analysis.maxFiles',
      'analysis.includePatterns',
      'analysis.excludePatterns',
      'generation.domains',
      'specStore.name',
      'specStore.path',
      'specStore.targets',
    ]);
  });

  it('rejects invalid enum members and invalid array elements', () => {
    const findings = validateOpenLoreConfig({
      ...FULLY_POPULATED,
      projectType: 'brainfuck',
      generation: { domains: ['api', 42] },
      impactCertificate: {
        surfaces: [{ name: 'data', members: [{ file: 42 }], severity: 'urgent' }],
      },
    });

    expect(findings.map(f => f.key)).toEqual([
      'projectType',
      'generation.domains[1]',
      'impactCertificate.surfaces[0].members[0].file',
      'impactCertificate.surfaces[0].severity',
    ]);
  });
});

describe('config-schema — version skew', () => {
  it('discloses a newer version stamp gracefully (no crash, no hard fail)', () => {
    const findings = validateOpenLoreConfig({ ...FULLY_POPULATED, version: '99.0.0' });
    const f = findings.find(x => x.kind === 'version-newer');
    expect(f).toBeDefined();
    expect(f?.message).toContain('newer');
  });

  it('an older stamp with only additive growth is silent (forward compatible)', () => {
    // No registered migration between 0.9.0 and current → nothing to report.
    const findings = checkConfigVersion('0.9.0', { current: '1.5.0', migrations: [] });
    expect(findings).toEqual([]);
  });

  it('an older stamp predating a registered breaking change is reported, naming the fields', () => {
    const migrations: ConfigMigration[] = [
      { since: '1.2.0', fields: ['oldKey'], note: "'oldKey' was renamed to 'newKey'" },
    ];
    const findings = checkConfigVersion('1.0.0', { current: '1.5.0', migrations });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('version-older');
    expect(findings[0].message).toContain('oldKey');
    expect(findings[0].message).toContain('older OpenLore');
  });

  it('a migration outside the (stamp, current] range does not fire', () => {
    const migrations: ConfigMigration[] = [
      { since: '2.0.0', fields: ['futureKey'], note: 'future change' },
    ];
    const findings = checkConfigVersion('1.0.0', { current: '1.5.0', migrations });
    expect(findings).toEqual([]);
  });

  it('an equal stamp is silent', () => {
    expect(checkConfigVersion('1.5.0', { current: '1.5.0' })).toEqual([]);
  });

  it('a non-semver stamp is not treated as version skew (type-mismatch path owns non-strings)', () => {
    expect(checkConfigVersion('not-a-version', { current: '1.0.0' })).toEqual([]);
    expect(checkConfigVersion(42, { current: '1.0.0' })).toEqual([]);
  });
});

describe('config-schema — robustness', () => {
  it('a non-object parsed value is an attributable root type mismatch', () => {
    for (const value of [null, 'string', [1, 2, 3], 42]) {
      expect(validateOpenLoreConfig(value)).toEqual([
        expect.objectContaining({ kind: 'type-mismatch', key: '<root>' }),
      ]);
    }
  });

  it('never throws on arbitrary shapes', () => {
    expect(() => validateOpenLoreConfig({ a: 1, b: [null], c: { d: undefined } })).not.toThrow();
  });

  it('orders findings as unknown-keys, then type-mismatches, then version skew', () => {
    const findings = validateOpenLoreConfig({
      ...FULLY_POPULATED,
      version: '99.0.0', // newer → version-newer (last)
      analysis: 'bad', // type-mismatch (middle)
      pancResponse: {}, // unknown-key (first)
    });
    const kinds = findings.map(f => f.kind);
    expect(kinds.indexOf('unknown-key')).toBeLessThan(kinds.indexOf('type-mismatch'));
    expect(kinds.indexOf('type-mismatch')).toBeLessThan(kinds.indexOf('version-newer'));
  });
});
