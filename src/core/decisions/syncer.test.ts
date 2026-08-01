/**
 * Tests for decision syncer — pure helpers + dryRun integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncApprovedDecisions } from './syncer.js';
import type { PendingDecision, DecisionStore, SpecMap } from '../../types/index.js';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    warning: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    section: vi.fn(),
    discovery: vi.fn(),
    analysis: vi.fn(),
    blank: vi.fn(),
  },
}));

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.js')>();
  return { ...actual, saveDecisionStore: vi.fn() };
});

// ============================================================================
// HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `decisions-syncer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'aaaabbbb',
    status: 'approved',
    title: 'Use Redis for caching',
    rationale: 'Reduces DB load by moving session data to an in-memory store.',
    consequences: 'Requires Redis in production. Session TTL must be managed.',
    proposedRequirement: 'The system SHALL use Redis for session caching.',
    affectedDomains: ['services'],
    affectedFiles: ['src/services/cache.ts'],
    confidence: 'high',
    sessionId: 'sess-001',
    recordedAt: '2026-04-18T10:00:00Z',
    syncedToSpecs: [],
    ...overrides,
  };
}

function makeStore(decisions: PendingDecision[]): DecisionStore {
  return {
    version: '1',
    sessionId: 'sess-001',
    updatedAt: '2026-04-18T10:00:00Z',
    decisions,
  };
}

function makeSpecMap(domain: string, specPath: string): SpecMap {
  const byDomain = new Map<string, { specPath: string; sourcePaths: string[] }>();
  byDomain.set(domain, { specPath, sourcePaths: [] });
  return {
    byDomain,
    byFile: new Map(),
  } as unknown as SpecMap;
}

// Minimal spec.md content with required header and sections
const MINIMAL_SPEC = `# Services Spec

> Source files: src/services/old.ts

## Requirements

### Requirement: ExistingReq

The system SHALL do something.

## Technical Notes

Notes here.
`;

// ============================================================================
// appendToSpec — pure integration via syncApprovedDecisions dryRun:false
// ============================================================================

describe('syncApprovedDecisions — filesystem writes', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('appends requirement and decision section to spec', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    const decision = makeDecision();
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const { result } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    expect(result.synced).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.modifiedSpecs).toContain('openspec/specs/services/spec.md');

    const content = await readFile(specPath, 'utf-8');
    expect(content).toContain('### Requirement: UseRedisForCaching');
    expect(content).toContain('The system SHALL use Redis for session caching.');
    expect(content).toContain('#### Scenario: The decision requirement is enforced');
    expect(content).toContain('- **GIVEN** approved decision `aaaabbbb`');
    expect(content).toContain('- **WHEN** the affected behavior is evaluated');
    expect(content).toContain('- **THEN** The system SHALL use Redis for session caching.');
    expect(content).toContain('## Decisions');
    expect(content).toContain('### Use Redis for caching');
    expect(content).toContain('**ID:** aaaabbbb');
  });

  it('does not duplicate "The system SHALL" prefix', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    // proposedRequirement already starts with "The system SHALL"
    const decision = makeDecision({
      proposedRequirement: 'The system SHALL use Redis for session caching.',
    });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    const content = await readFile(specPath, 'utf-8');
    expect(content).not.toContain('The system SHALL The system SHALL');
  });

  it('preserves a requirement with its own subject and normative modal', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    await syncApprovedDecisions(makeStore([makeDecision({
      proposedRequirement: 'The orient command SHALL disclose an empty result.',
    })]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });

    const content = await readFile(specPath, 'utf-8');
    expect(content).toContain('The orient command SHALL disclose an empty result.');
    expect(content).not.toContain('The system SHALL The orient command SHALL');
  });

  it('supplies a subject when a requirement starts with a normative modal', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    await syncApprovedDecisions(makeStore([makeDecision({
      proposedRequirement: 'MUST preserve the decision marker.',
    })]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });

    expect(await readFile(specPath, 'utf-8')).toContain(
      'The system MUST preserve the decision marker.',
    );
  });

  it('leaves the spec unchanged and reports a named error for invalid emission', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    const { result, store } = await syncApprovedDecisions(makeStore([makeDecision({
      title: '!!!',
    })]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });

    expect(result.synced).toHaveLength(0);
    expect(result.errors).toEqual([{
      id: 'aaaabbbb',
      error: expect.stringContaining('DecisionRequirementValidationError'),
    }]);
    expect(store.decisions).toContainEqual(expect.objectContaining({
      id: 'aaaabbbb',
      status: 'approved',
    }));
    expect(await readFile(specPath, 'utf-8')).toBe(MINIMAL_SPEC);
  });

  it('is idempotent — re-syncing the same decision does not duplicate blocks', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');
    const opts = { rootPath: tmpDir, openspecPath: join(tmpDir, 'openspec'), specMap };

    // Sync the same decision (same id) twice. A re-sync — or consolidation re-minting
    // an id — would otherwise append a SECOND requirement + decision block, the exact
    // spec corruption observed in the field.
    await syncApprovedDecisions(makeStore([makeDecision()]), opts);
    await syncApprovedDecisions(makeStore([makeDecision()]), opts);

    const content = await readFile(specPath, 'utf-8');
    expect((content.match(/### Requirement: UseRedisForCaching/g) ?? []).length).toBe(1);
    expect((content.match(/\*\*ID:\*\* aaaabbbb/g) ?? []).length).toBe(1);
    expect((content.match(/### Use Redis for caching/g) ?? []).length).toBe(1);
  });

  it('scopes a multi-domain decision to one owning domain, pointers elsewhere', async () => {
    // Requirement: DecisionSyncWritesOneOwningDomain. The full requirement +
    // Decisions entry lands in the FIRST affected domain; every other affected
    // domain carries a one-line pointer only — never the verbatim block.
    const { writeFile } = await import('node:fs/promises');
    const paths: Record<string, string> = {};
    for (const domain of ['services', 'drift', 'cli']) {
      const specDir = join(tmpDir, 'custom-specs', domain);
      await mkdir(specDir, { recursive: true });
      const p = join(specDir, 'spec.md');
      await writeFile(p, MINIMAL_SPEC, 'utf-8');
      paths[domain] = p;
    }

    const byDomain = new Map<string, { specPath: string; sourcePaths: string[] }>([
      ['services', { specPath: 'custom-specs/services/spec.md', sourcePaths: [] }],
      ['drift', { specPath: 'custom-specs/drift/spec.md', sourcePaths: [] }],
      ['cli', { specPath: 'custom-specs/cli/spec.md', sourcePaths: [] }],
    ]);
    const specMap = { byDomain, byFile: new Map() } as unknown as SpecMap;
    const opts = { rootPath: tmpDir, openspecPath: join(tmpDir, 'openspec'), specMap };
    const decision = makeDecision({ affectedDomains: ['services', 'drift', 'cli'] });

    const { result } = await syncApprovedDecisions(makeStore([decision]), opts);

    // Every affected spec is reported modified (owner write + two pointer writes).
    expect(result.modifiedSpecs).toContain('custom-specs/services/spec.md');
    expect(result.modifiedSpecs).toContain('custom-specs/drift/spec.md');
    expect(result.modifiedSpecs).toContain('custom-specs/cli/spec.md');

    // Owner (first affected domain) holds the full block.
    const owner = await readFile(paths.services, 'utf-8');
    expect(owner).toContain('### Requirement: UseRedisForCaching');
    expect(owner).toContain('**ID:** aaaabbbb');
    expect(owner).not.toContain('> Decision pointer:');

    // Non-owning domains hold a schema-valid normative deferral, not the
    // canonical requirement or decision entry.
    for (const domain of ['drift', 'cli']) {
      const other = await readFile(paths[domain], 'utf-8');
      expect(other).toContain('### Requirement: UseRedisForCaching');
      expect(other).toContain(
        'This domain SHALL conform to the canonical statement of decision `aaaabbbb`',
      );
      expect(other).toContain('#### Scenario: The canonical statement governs');
      expect(other).toContain('- **GIVEN** decision `aaaabbbb` recorded in the `services` domain');
      expect(other).toContain('- **WHEN** this domain\'s behavior touches that decision\'s surface');
      expect(other).toContain(
        '- **THEN** it satisfies the canonical requirement as stated in [services/spec.md](../services/spec.md)',
      );
      expect(other).toContain('> Decision pointer: aaaabbbb');
      expect(other).toContain('custom-specs/services/spec.md');
      expect(other).not.toContain('The system SHALL use Redis for session caching.');
      expect(other).not.toContain('**ID:** aaaabbbb');
    }

    // Re-syncing does not fan out duplicate pointers.
    await syncApprovedDecisions(makeStore([makeDecision({ affectedDomains: ['services', 'drift', 'cli'] })]), opts);
    const driftAgain = await readFile(paths.drift, 'utf-8');
    expect((driftAgain.match(/> Decision pointer: aaaabbbb/g) ?? []).length).toBe(1);
  });

  it('adds new source files to > Source files: header', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    const decision = makeDecision({ affectedFiles: ['src/services/cache.ts', 'src/services/session.ts'] });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    const content = await readFile(specPath, 'utf-8');
    expect(content).toContain('src/services/cache.ts');
    expect(content).toContain('src/services/session.ts');
  });

  it('does not re-add already present source files', async () => {
    const specWithFile = MINIMAL_SPEC.replace(
      '> Source files: src/services/old.ts',
      '> Source files: src/services/old.ts, src/services/cache.ts',
    );
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, specWithFile, 'utf-8');

    const decision = makeDecision({ affectedFiles: ['src/services/cache.ts'] });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    const content = await readFile(specPath, 'utf-8');
    const occurrences = (content.match(/src\/services\/cache\.ts/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('skips decisions where domain not found in specMap (logs warning)', async () => {
    const { logger } = await import('../../utils/logger.js');
    // scope: cross-domain so ADR is written despite missing spec domain
    const decision = makeDecision({ affectedDomains: ['nonexistent-domain'], scope: 'cross-domain' });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const { result } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    expect(result.synced).toHaveLength(1);
    // ADR written (cross-domain scope); no spec file written (domain missing)
    expect(result.modifiedSpecs).toHaveLength(1);
    expect(result.modifiedSpecs[0]).toMatch(/^openspec\/decisions\/adr-/);
    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('nonexistent-domain'),
    );
  });

  it('dry-run returns modifiedSpecs without writing', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    const decision = makeDecision();
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const { result } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
      dryRun: true,
    });

    expect(result.modifiedSpecs).toContain('openspec/specs/services/spec.md');

    // File must be unchanged
    const content = await readFile(specPath, 'utf-8');
    expect(content).toBe(MINIMAL_SPEC);
  });

  it('skips non-approved decisions', async () => {
    const decision = makeDecision({ status: 'verified' });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const { result } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    expect(result.synced).toHaveLength(0);
  });

  it('purges inactive decisions from store before saving', async () => {
    const approved = makeDecision({ id: 'app00001', status: 'approved', affectedDomains: ['services'] });
    const rejected = makeDecision({ id: 'rej00001', status: 'rejected' });
    const synced = makeDecision({ id: 'syn00001', status: 'synced' });
    const verified = makeDecision({ id: 'ver00001', status: 'verified' });
    const store = makeStore([approved, rejected, synced, verified]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const { store: persisted } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    // syncer persists via CAS; the returned store is the committed (purged) result.
    const ids = persisted.decisions.map((d) => d.id);
    // rejected + synced (original) purged; newly-synced approved also purged; verified kept
    expect(ids).not.toContain('rej00001');
    expect(ids).not.toContain('syn00001');
    expect(ids).not.toContain('app00001');
    expect(ids).toContain('ver00001');
  });
});

// ============================================================================
// ADR creation — always writes an ADR for every synced decision
// ============================================================================

describe('ADR creation — always writes ADR regardless of content', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates ADR placeholder in dryRun for cross-domain decision', async () => {
    const decision = makeDecision({
      title: 'Add retry logic',
      rationale: 'Retry failed HTTP requests up to 3 times.',
      scope: 'cross-domain',
    });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(specDir, 'spec.md'), MINIMAL_SPEC, 'utf-8');

    const { result } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
      dryRun: true,
    });

    expect(result.modifiedSpecs.some((p) => p.startsWith('openspec/decisions/adr-'))).toBe(true);
  });

  it('writes ADR file on disk for cross-domain approved decision', async () => {
    const decision = makeDecision({
      title: 'Add retry logic',
      rationale: 'Retry failed HTTP requests up to 3 times.',
      scope: 'cross-domain',
    });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const { writeFile, readdir } = await import('node:fs/promises');
    await writeFile(join(specDir, 'spec.md'), MINIMAL_SPEC, 'utf-8');

    await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    const files = await readdir(join(tmpDir, 'openspec', 'decisions'));
    expect(files.some((f) => f.startsWith('adr-'))).toBe(true);
  });

  it('increments ADR number for each successive decision', async () => {
    const d1 = makeDecision({ id: 'aaa00001', title: 'First decision', scope: 'cross-domain' });
    const d2 = makeDecision({ id: 'bbb00002', title: 'Second decision', status: 'approved', scope: 'system' });
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const { writeFile, readdir } = await import('node:fs/promises');
    await writeFile(join(specDir, 'spec.md'), MINIMAL_SPEC, 'utf-8');
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    // Sync first
    await syncApprovedDecisions(makeStore([d1]), {
      rootPath: tmpDir, openspecPath: join(tmpDir, 'openspec'), specMap,
    });
    // Sync second
    await syncApprovedDecisions(makeStore([d2]), {
      rootPath: tmpDir, openspecPath: join(tmpDir, 'openspec'), specMap,
    });

    const files = await readdir(join(tmpDir, 'openspec', 'decisions'));
    expect(files.filter((f) => f.startsWith('adr-'))).toHaveLength(2);
    expect(files.some((f) => f.startsWith('adr-0001-'))).toBe(true);
    expect(files.some((f) => f.startsWith('adr-0002-'))).toBe(true);
  });
});

// ============================================================================
// appendDecisionSection — creates ## Decisions header if absent
// ============================================================================

describe('appendDecisionSection via full sync', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates ## Decisions section when absent', async () => {
    const spec = `# My Spec\n\n## Requirements\n\nSome req.\n`;
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, spec, 'utf-8');

    const decision = makeDecision({ proposedRequirement: null });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    const content = await readFile(specPath, 'utf-8');
    expect(content).toContain('## Decisions');
    expect(content).toContain('### Use Redis for caching');
  });

  it('appends to existing ## Decisions section', async () => {
    const spec = `# My Spec\n\n## Decisions\n\n### Old Decision\n\nSome old decision.\n`;
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, spec, 'utf-8');

    const decision = makeDecision({ proposedRequirement: null });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    const content = await readFile(specPath, 'utf-8');
    expect(content).toContain('### Old Decision');
    expect(content).toContain('### Use Redis for caching');
    // Only one ## Decisions header
    const occurrences = (content.match(/^## Decisions/gm) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ============================================================================
// ADR scope gate — qualifiesForADR via syncApprovedDecisions
// ============================================================================

describe('ADR scope gate', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  async function syncWithScope(scope: PendingDecision['scope']): Promise<string[]> {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(specDir, 'spec.md'), MINIMAL_SPEC, 'utf-8');
    const decision = makeDecision({ scope });
    const { result } = await syncApprovedDecisions(makeStore([decision]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
      dryRun: true,
    });
    return result.modifiedSpecs;
  }

  it('cross-domain scope → ADR included in modifiedSpecs', async () => {
    const specs = await syncWithScope('cross-domain');
    expect(specs.some((p) => p.startsWith('openspec/decisions/adr-'))).toBe(true);
  });

  it('system scope → ADR included in modifiedSpecs', async () => {
    const specs = await syncWithScope('system');
    expect(specs.some((p) => p.startsWith('openspec/decisions/adr-'))).toBe(true);
  });

  it('component scope → no ADR in modifiedSpecs', async () => {
    const specs = await syncWithScope('component');
    expect(specs.some((p) => p.startsWith('openspec/decisions/adr-'))).toBe(false);
  });

  it('local scope → no ADR in modifiedSpecs', async () => {
    const specs = await syncWithScope('local');
    expect(specs.some((p) => p.startsWith('openspec/decisions/adr-'))).toBe(false);
  });

  it('undefined scope (backward compat) → no ADR in modifiedSpecs', async () => {
    const specs = await syncWithScope(undefined);
    expect(specs.some((p) => p.startsWith('openspec/decisions/adr-'))).toBe(false);
  });

  it('component scope → still syncs to spec file', async () => {
    const specs = await syncWithScope('component');
    expect(specs).toContain('openspec/specs/services/spec.md');
  });

  it('system scope writes ADR file on disk', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const { writeFile, readdir } = await import('node:fs/promises');
    await writeFile(join(specDir, 'spec.md'), MINIMAL_SPEC, 'utf-8');
    await syncApprovedDecisions(makeStore([makeDecision({ scope: 'system' })]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });
    const files = await readdir(join(tmpDir, 'openspec', 'decisions'));
    expect(files.some((f) => f.startsWith('adr-'))).toBe(true);
  });
});
