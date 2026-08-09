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
  type ConfigMigration,
} from './config-schema.js';

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
};

describe('config-schema — type-completeness bind', () => {
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

  it('flags lastRun holding a number', () => {
    const findings = validateOpenLoreConfig({ ...FULLY_POPULATED, lastRun: 123 });
    const f = findings.find(x => x.key === 'lastRun');
    expect(f?.kind).toBe('type-mismatch');
    expect(f?.message).toContain('a string or null');
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
  it('a non-object input yields no findings (JSON parse already reported syntax errors)', () => {
    expect(validateOpenLoreConfig(null)).toEqual([]);
    expect(validateOpenLoreConfig('string')).toEqual([]);
    expect(validateOpenLoreConfig([1, 2, 3])).toEqual([]);
    expect(validateOpenLoreConfig(42)).toEqual([]);
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
