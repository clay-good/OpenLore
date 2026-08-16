/**
 * Tests for openloreGetSpecRequirements programmatic API
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { openloreGetSpecRequirements } from './specs.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

let testDir: string;

/** Build the .openlore/analysis/mapping.json fixture */
async function writeMapping(dir: string, payload: object): Promise<void> {
  const analysisDir = join(dir, '.openlore', 'analysis');
  await mkdir(analysisDir, { recursive: true });
  await writeFile(join(analysisDir, 'mapping.json'), JSON.stringify(payload, null, 2));
}

/** Write a spec markdown file with one or more "### Requirement:" sections */
async function writeSpecFile(dir: string, relPath: string, content: string): Promise<void> {
  const abs = join(dir, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content);
}

function makeSpecContent(entries: Array<{ title: string; body: string }>): string {
  return entries.map(({ title, body }) => `### Requirement: ${title}\n${body}`).join('\n\n');
}

// ============================================================================
// TESTS: no mapping.json
// ============================================================================

describe('openloreGetSpecRequirements — no mapping.json', () => {
  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `openlore-specs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns empty requirements when mapping.json does not exist', async () => {
    const result = await openloreGetSpecRequirements({ rootPath: testDir });

    expect(result.requirements).toEqual({});
    expect(result.generatedAt).toBeUndefined();
  });

  it('uses process.cwd() when rootPath is omitted (smoke test — no throw)', async () => {
    // We cannot control cwd in tests, but the call must not throw
    await expect(openloreGetSpecRequirements()).resolves.toBeDefined();
  });
});

// ============================================================================
// TESTS: mapping.json present, basic extraction
// ============================================================================

describe('openloreGetSpecRequirements — basic extraction', () => {
  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `openlore-specs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns generatedAt from mapping.json', async () => {
    await writeMapping(testDir, {
      generatedAt: '2024-01-15T10:00:00.000Z',
      mappings: [],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });
    expect(result.generatedAt).toBe('2024-01-15T10:00:00.000Z');
  });

  it('returns empty requirements when mappings array is empty', async () => {
    await writeMapping(testDir, { generatedAt: '2024-01-01T00:00:00Z', mappings: [] });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });
    expect(result.requirements).toEqual({});
  });

  it('extracts requirement body from spec file', async () => {
    const specRel = 'openspec/specs/auth.md';
    await writeSpecFile(
      testDir,
      specRel,
      makeSpecContent([
        { title: 'User Login', body: 'Users must be able to log in with email and password.' },
      ])
    );

    await writeMapping(testDir, {
      generatedAt: '2024-01-01T00:00:00Z',
      mappings: [
        { requirement: 'User Login', specFile: specRel, domain: 'auth', service: 'login-service' },
      ],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });

    expect(result.requirements['User Login']).toMatchObject({
      title: 'User Login',
      body: 'Users must be able to log in with email and password.',
      specFile: specRel,
      domain: 'auth',
      service: 'login-service',
    });
  });

  it('extracts multiple requirements from the same spec file', async () => {
    const specRel = 'openspec/specs/auth.md';
    await writeSpecFile(
      testDir,
      specRel,
      makeSpecContent([
        { title: 'User Login', body: 'Login body.' },
        { title: 'User Logout', body: 'Logout body.' },
      ])
    );

    await writeMapping(testDir, {
      mappings: [
        { requirement: 'User Login', specFile: specRel },
        { requirement: 'User Logout', specFile: specRel },
      ],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });

    expect(result.requirements['User Login'].body).toBe('Login body.');
    expect(result.requirements['User Logout'].body).toBe('Logout body.');
  });

  it('extracts requirements from different spec files', async () => {
    const spec1 = 'openspec/specs/auth.md';
    const spec2 = 'openspec/specs/billing.md';

    await writeSpecFile(
      testDir,
      spec1,
      makeSpecContent([{ title: 'User Login', body: 'Auth body.' }])
    );
    await writeSpecFile(
      testDir,
      spec2,
      makeSpecContent([{ title: 'Invoice Generation', body: 'Billing body.' }])
    );

    await writeMapping(testDir, {
      mappings: [
        { requirement: 'User Login', specFile: spec1, domain: 'auth' },
        { requirement: 'Invoice Generation', specFile: spec2, domain: 'billing' },
      ],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });

    expect(result.requirements['User Login'].body).toBe('Auth body.');
    expect(result.requirements['Invoice Generation'].body).toBe('Billing body.');
  });
});

// ============================================================================
// TESTS: case-insensitive title matching
// ============================================================================

describe('openloreGetSpecRequirements — case-insensitive title matching', () => {
  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `openlore-specs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('matches requirement title case-insensitively', async () => {
    const specRel = 'openspec/specs/auth.md';
    // The spec file uses a different casing than the mapping key
    await writeSpecFile(testDir, specRel, '### Requirement: USER LOGIN\nBody text here.');

    await writeMapping(testDir, {
      mappings: [{ requirement: 'user login', specFile: specRel }],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });

    expect(result.requirements['user login']).toBeDefined();
    expect(result.requirements['user login'].body).toBe('Body text here.');
    // title should reflect the heading as written in the file
    expect(result.requirements['user login'].title).toBe('USER LOGIN');
  });

  it('preserves the original file title casing in the result', async () => {
    const specRel = 'openspec/specs/feature.md';
    await writeSpecFile(testDir, specRel, '### Requirement: My Feature\nContent.');

    await writeMapping(testDir, {
      mappings: [{ requirement: 'my feature', specFile: specRel }],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });
    expect(result.requirements['my feature'].title).toBe('My Feature');
  });
});

// ============================================================================
// TESTS: placeholder / fallback behaviour
// ============================================================================

describe('openloreGetSpecRequirements — placeholders and fallbacks', () => {
  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `openlore-specs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns placeholder when specFile is absent from mapping entry', async () => {
    await writeMapping(testDir, {
      mappings: [{ requirement: 'Orphan Req', domain: 'core' }],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });
    const req = result.requirements['Orphan Req'];

    expect(req).toBeDefined();
    expect(req.title).toBe('Orphan Req');
    expect(req.body).toBe('');
    expect(req.specFile).toBeUndefined();
    expect(req.domain).toBe('core');
  });

  it('returns placeholder when specFile does not exist on disk', async () => {
    await writeMapping(testDir, {
      mappings: [
        {
          requirement: 'Missing File Req',
          specFile: 'openspec/specs/ghost.md',
          service: 'ghost-svc',
        },
      ],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });
    const req = result.requirements['Missing File Req'];

    expect(req.title).toBe('Missing File Req');
    expect(req.body).toBe('');
    expect(req.specFile).toBe('openspec/specs/ghost.md');
    expect(req.service).toBe('ghost-svc');
  });

  it('returns placeholder when requirement heading is not found in spec file', async () => {
    const specRel = 'openspec/specs/other.md';
    await writeSpecFile(
      testDir,
      specRel,
      makeSpecContent([{ title: 'Different Req', body: 'Different body.' }])
    );

    await writeMapping(testDir, {
      mappings: [{ requirement: 'Missing Heading', specFile: specRel }],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });
    const req = result.requirements['Missing Heading'];

    expect(req.title).toBe('Missing Heading');
    expect(req.body).toBe('');
    expect(req.specFile).toBe(specRel);
  });

  it('skips mapping entries that have no requirement key', async () => {
    await writeMapping(testDir, {
      mappings: [
        { specFile: 'openspec/specs/auth.md', domain: 'auth' }, // no requirement field
        { requirement: 'Valid Req', domain: 'core' },
      ],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });

    const keys = Object.keys(result.requirements);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('Valid Req');
  });

  it('applies first-wins deduplication for repeated requirement keys', async () => {
    const spec1 = 'openspec/specs/a.md';
    const spec2 = 'openspec/specs/b.md';

    await writeSpecFile(
      testDir,
      spec1,
      makeSpecContent([{ title: 'Dup Req', body: 'First body.' }])
    );
    await writeSpecFile(
      testDir,
      spec2,
      makeSpecContent([{ title: 'Dup Req', body: 'Second body.' }])
    );

    await writeMapping(testDir, {
      mappings: [
        { requirement: 'Dup Req', specFile: spec1 },
        { requirement: 'Dup Req', specFile: spec2 }, // should be ignored
      ],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });

    expect(result.requirements['Dup Req'].body).toBe('First body.');
  });
});

// ============================================================================
// TESTS: multi-line body extraction
// ============================================================================

describe('openloreGetSpecRequirements — multi-line body extraction', () => {
  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `openlore-specs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('captures multi-line markdown body correctly', async () => {
    const specRel = 'openspec/specs/detailed.md';
    const multiLineBody = `The system shall support:
- Feature A
- Feature B

Additional constraints apply.`;

    await writeSpecFile(
      testDir,
      specRel,
      `### Requirement: Rich Req\n${multiLineBody}\n\n### Requirement: Other Req\nOther body.`
    );

    await writeMapping(testDir, {
      mappings: [{ requirement: 'Rich Req', specFile: specRel }],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });
    expect(result.requirements['Rich Req'].body).toContain('Feature A');
    expect(result.requirements['Rich Req'].body).toContain('Additional constraints apply.');
  });

  it('trims leading and trailing whitespace from the extracted body', async () => {
    const specRel = 'openspec/specs/trimmed.md';
    await writeSpecFile(
      testDir,
      specRel,
      '### Requirement: Trimmed Req\n\n  Some body text.  \n\n'
    );

    await writeMapping(testDir, {
      mappings: [{ requirement: 'Trimmed Req', specFile: specRel }],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });
    // body is trimmed
    expect(result.requirements['Trimmed Req'].body).toBe('Some body text.');
  });
});

// ============================================================================
// TESTS: malformed inputs
// ============================================================================

describe('openloreGetSpecRequirements — malformed inputs', () => {
  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `openlore-specs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns empty requirements when mapping.json is invalid JSON', async () => {
    const analysisDir = join(testDir, '.openlore', 'analysis');
    await mkdir(analysisDir, { recursive: true });
    await writeFile(join(analysisDir, 'mapping.json'), '{ this is not valid json >>>');

    const result = await openloreGetSpecRequirements({ rootPath: testDir });

    expect(result.requirements).toEqual({});
  });

  it('returns empty requirements when mappings field is missing', async () => {
    await writeMapping(testDir, { generatedAt: '2024-01-01T00:00:00Z' /* no mappings field */ });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });
    expect(result.requirements).toEqual({});
  });

  it('handles spec file that is not valid utf-8 / unreadable gracefully', async () => {
    const specRel = 'openspec/specs/binary.md';
    const absPath = join(testDir, specRel);
    await mkdir(join(testDir, 'openspec', 'specs'), { recursive: true });
    // Write binary content that will cause a parse issue when treated as sections
    await writeFile(absPath, Buffer.from([0xff, 0xfe, 0x00, 0x01]));

    await writeMapping(testDir, {
      mappings: [{ requirement: 'Binary Req', specFile: specRel }],
    });

    // Should not throw; should return a placeholder
    const result = await openloreGetSpecRequirements({ rootPath: testDir });
    expect(result.requirements['Binary Req']).toBeDefined();
    expect(result.requirements['Binary Req'].body).toBe('');
  });

  it('does not read a mapping path outside the project root', async () => {
    const outside = join(testDir, '..', `openlore-secret-${Date.now()}.md`);
    try {
      await writeFile(outside, '### Requirement: Escaped\nsecret body');
      await writeMapping(testDir, {
        mappings: [{ requirement: 'Escaped', specFile: `../${basename(outside)}` }],
      });

      const result = await openloreGetSpecRequirements({ rootPath: testDir });
      expect(result.requirements.Escaped.body).toBe('');
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('does not read through an in-root symlink to an external spec directory', async () => {
    const outside = join(testDir, '..', `openlore-spec-outside-${Date.now()}`);
    try {
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'spec.md'), '### Requirement: Escaped\nsecret body');
      await symlink(outside, join(testDir, 'linked-specs'), 'dir');
      await writeMapping(testDir, {
        mappings: [{ requirement: 'Escaped', specFile: 'linked-specs/spec.md' }],
      });

      const result = await openloreGetSpecRequirements({ rootPath: testDir });
      expect(result.requirements.Escaped.body).toBe('');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not read mapping.json through an outbound .openlore symlink', async () => {
    const outside = join(testDir, '..', `openlore-mapping-outside-${Date.now()}`);
    try {
      await mkdir(join(outside, 'analysis'), { recursive: true });
      await writeFile(join(outside, 'analysis', 'mapping.json'), JSON.stringify({
        mappings: [{ requirement: 'External', domain: 'outside' }],
      }));
      await symlink(outside, join(testDir, '.openlore'), 'dir');

      const result = await openloreGetSpecRequirements({ rootPath: testDir });
      expect(result.requirements.External).toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('preserves __proto__ as an own data key without prototype mutation', async () => {
    await writeMapping(testDir, {
      mappings: [{ requirement: '__proto__', domain: 'hostile' }],
    });

    const result = await openloreGetSpecRequirements({ rootPath: testDir });
    expect(Object.prototype.hasOwnProperty.call(result.requirements, '__proto__')).toBe(true);
    expect(result.requirements['__proto__'].domain).toBe('hostile');
    expect(Object.getPrototypeOf(result.requirements)).toBeNull();
    expect(JSON.parse(JSON.stringify(result.requirements))['__proto__'].domain).toBe('hostile');
  });
});

// ============================================================================
// TESTS: barrel export
// ============================================================================

describe('barrel exports from index.js', () => {
  it('exports openloreGetSpecRequirements', async () => {
    const api = await import('./index.js');
    expect(typeof api.openloreGetSpecRequirements).toBe('function');
  });

  it('exports openloreInit', async () => {
    const api = await import('./index.js');
    expect(typeof api.openloreInit).toBe('function');
  });

  it('exports openloreAnalyze', async () => {
    const api = await import('./index.js');
    expect(typeof api.openloreAnalyze).toBe('function');
  });

  it('exports openloreGenerate', async () => {
    const api = await import('./index.js');
    expect(typeof api.openloreGenerate).toBe('function');
  });

  it('exports openloreRun', async () => {
    const api = await import('./index.js');
    expect(typeof api.openloreRun).toBe('function');
  });

  it('exports openloreVerify', async () => {
    const api = await import('./index.js');
    expect(typeof api.openloreVerify).toBe('function');
  });

  it('exports openloreDrift', async () => {
    const api = await import('./index.js');
    expect(typeof api.openloreDrift).toBe('function');
  });
});
