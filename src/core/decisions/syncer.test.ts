/**
 * Tests for decision syncer — pure helpers + dryRun integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyFile, mkdir, rm, readFile, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncApprovedDecisions } from './syncer.js';
import { detectCorpusIntegrity } from './corpus-integrity.js';
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
    contentOrigin: 'agent-recorded',
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

  it('canonicalizes a lowercase normative modal', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    await syncApprovedDecisions(makeStore([makeDecision({
      proposedRequirement: 'The orient command must disclose an empty result.',
    })]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });

    expect(await readFile(specPath, 'utf-8')).toContain(
      'The orient command MUST disclose an empty result.',
    );
  });

  it('rejects multiline Markdown requirements without changing the spec', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    const { result } = await syncApprovedDecisions(makeStore([makeDecision({
      proposedRequirement: 'The system SHALL work.\n\n### Requirement: Injected',
    })]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });

    expect(result.errors).toEqual([{
      id: 'aaaabbbb',
      error: expect.stringContaining('DecisionRequirementValidationError'),
    }]);
    expect(await readFile(specPath, 'utf-8')).toBe(MINIMAL_SPEC);
  });

  it.each([
    ['title', { title: 'Safe title\n\n### Requirement: Injected' }],
    ['affected file', { affectedFiles: ['src/cache.ts\n### Requirement: Injected'] }],
    ['rationale', { rationale: 'Safe rationale\n\n### Requirement: Injected' }],
    ['consequences', { consequences: 'Safe consequence\n\n### Requirement: Injected' }],
  ])('rejects multiline %s metadata without changing the spec', async (_field, overrides) => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    const { result } = await syncApprovedDecisions(
      makeStore([makeDecision(overrides)]),
      {
        rootPath: tmpDir,
        openspecPath: join(tmpDir, 'openspec'),
        specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
      },
    );

    expect(result.errors[0]?.error).toContain('DecisionRequirementValidationError');
    expect(await readFile(specPath, 'utf-8')).toBe(MINIMAL_SPEC);
  });

  it('allows safe multiline rationale and consequences prose', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    const { result } = await syncApprovedDecisions(makeStore([makeDecision({
      rationale: 'The first paragraph explains the choice.\n\nThe second adds evidence.',
      consequences: 'Operators gain predictable behavior.\n\nThey also own the migration.',
    })]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });

    expect(result.errors).toEqual([]);
    const content = await readFile(specPath, 'utf-8');
    expect(content).toContain('The second adds evidence.');
    expect(content).toContain('They also own the migration.');
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

  it('does not mistake prose mentions of dedupe markers for synced entries', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      specPath,
      `${MINIMAL_SPEC}\nA note mentions **ID:** aaaabbbb and > Decision recorded: aaaabbbb as examples.\n`,
      'utf-8',
    );

    const { result } = await syncApprovedDecisions(makeStore([makeDecision()]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });

    expect(result.errors).toEqual([]);
    const content = await readFile(specPath, 'utf-8');
    expect(content).toContain('### Requirement: UseRedisForCaching');
    expect(content).toContain('> Decision recorded: aaaabbbb\n');
    expect(content).toContain('**ID:** aaaabbbb\n');
  });

  it('scopes a multi-domain decision to one owning domain, pointers elsewhere', async () => {
    // Requirement: DecisionSyncWritesOneOwningDomain. The full requirement +
    // Decisions entry lands in the FIRST affected domain; every other affected
    // domain carries a normative deferral only — never the verbatim block.
    const { writeFile } = await import('node:fs/promises');
    const mappedPaths = {
      services: 'custom-specs/canonical/services.md',
      drift: 'custom-specs/consumers/drift/spec.md',
      cli: 'custom-specs/cli-reference.md',
    };
    const paths: Record<string, string> = {};
    for (const [domain, mappedPath] of Object.entries(mappedPaths)) {
      const p = join(tmpDir, mappedPath);
      await mkdir(join(p, '..'), { recursive: true });
      await writeFile(p, MINIMAL_SPEC, 'utf-8');
      paths[domain] = p;
    }

    const byDomain = new Map<string, { specPath: string; sourcePaths: string[] }>([
      ['services', { specPath: mappedPaths.services, sourcePaths: [] }],
      ['drift', { specPath: mappedPaths.drift, sourcePaths: [] }],
      ['cli', { specPath: mappedPaths.cli, sourcePaths: [] }],
    ]);
    const specMap = { byDomain, byFile: new Map() } as unknown as SpecMap;
    const opts = { rootPath: tmpDir, openspecPath: join(tmpDir, 'openspec'), specMap };
    const decision = makeDecision({ affectedDomains: ['services', 'drift', 'cli'] });

    const { result } = await syncApprovedDecisions(makeStore([decision]), opts);

    // Every affected spec is reported modified (owner write + two pointer writes).
    expect(result.modifiedSpecs).toContain(mappedPaths.services);
    expect(result.modifiedSpecs).toContain(mappedPaths.drift);
    expect(result.modifiedSpecs).toContain(mappedPaths.cli);

    // Owner (first affected domain) holds the full block.
    const owner = await readFile(paths.services, 'utf-8');
    expect(owner).toContain('### Requirement: UseRedisForCaching');
    expect(owner).toContain('**ID:** aaaabbbb');
    expect(owner).not.toContain('> Decision pointer:');

    // Non-owning domains hold a schema-valid normative deferral, not the
    // canonical requirement or decision entry.
    const expectedLinks = {
      drift: '../../canonical/services.md',
      cli: 'canonical/services.md',
    };
    for (const domain of ['drift', 'cli'] as const) {
      const other = await readFile(paths[domain], 'utf-8');
      expect(other).toContain('### Requirement: UseRedisForCaching');
      expect(other).toContain(
        'This domain SHALL conform to the canonical statement of decision `aaaabbbb`',
      );
      expect(other).toContain('#### Scenario: The canonical statement governs');
      expect(other).toContain('- **GIVEN** decision `aaaabbbb` recorded in the `services` domain');
      expect(other).toContain('- **WHEN** this domain\'s behavior touches that decision\'s surface');
      expect(other).toContain(
        `- **THEN** it satisfies the canonical requirement as stated in [services/spec.md](${expectedLinks[domain]})`,
      );
      expect(other).toContain('> Decision pointer: aaaabbbb');
      expect(other).toContain(mappedPaths.services);
      expect(other).not.toContain('The system SHALL use Redis for session caching.');
      expect(other).not.toContain('**ID:** aaaabbbb');
    }

    // Re-syncing does not fan out duplicate pointers.
    await syncApprovedDecisions(makeStore([makeDecision({ affectedDomains: ['services', 'drift', 'cli'] })]), opts);
    const driftAgain = await readFile(paths.drift, 'utf-8');
    expect((driftAgain.match(/> Decision pointer: aaaabbbb/g) ?? []).length).toBe(1);
  });

  it('uses a decision-entry pointer when a multi-domain decision has no requirement', async () => {
    const { writeFile } = await import('node:fs/promises');
    const byDomain = new Map<string, { specPath: string; sourcePaths: string[] }>();
    for (const domain of ['services', 'cli']) {
      const mappedPath = `openspec/specs/${domain}/spec.md`;
      const specPath = join(tmpDir, mappedPath);
      await mkdir(join(specPath, '..'), { recursive: true });
      await writeFile(specPath, MINIMAL_SPEC, 'utf-8');
      byDomain.set(domain, { specPath: mappedPath, sourcePaths: [] });
    }

    await syncApprovedDecisions(makeStore([makeDecision({
      proposedRequirement: null,
      affectedDomains: ['services', 'cli'],
    })]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: { byDomain, byFile: new Map() } as unknown as SpecMap,
    });

    const owner = await readFile(join(tmpDir, 'openspec/specs/services/spec.md'), 'utf-8');
    const other = await readFile(join(tmpDir, 'openspec/specs/cli/spec.md'), 'utf-8');
    expect(owner).not.toContain('### Requirement: UseRedisForCaching');
    expect(owner).toContain('**ID:** aaaabbbb');
    expect(other).toContain('> Decision pointer: aaaabbbb');
    expect(other).toContain('openspec/specs/services/spec.md');
    expect(other).not.toContain('canonical requirement');
    expect(other).not.toContain('### Requirement: UseRedisForCaching');
  });

  it(
    'keeps the formerly broken OpenSpec domains compatible with the host validator',
    async () => {
      const domains = ['cli', 'mcp-handlers', 'config', 'overview'];
      await mkdir(join(tmpDir, 'openspec', 'specs'), { recursive: true });
      await copyFile(
        join(process.cwd(), 'openspec', 'config.yaml'),
        join(tmpDir, 'openspec', 'config.yaml'),
      );

      const byDomain = new Map<string, { specPath: string; sourcePaths: string[] }>();
      for (const domain of domains) {
        const mappedPath = `openspec/specs/${domain}/spec.md`;
        const target = join(tmpDir, mappedPath);
        await mkdir(join(target, '..'), { recursive: true });
        await copyFile(join(process.cwd(), mappedPath), target);
        byDomain.set(domain, { specPath: mappedPath, sourcePaths: [] });
      }
      const specMap = { byDomain, byFile: new Map() } as unknown as SpecMap;

      for (const [index, domain] of domains.entries()) {
        await syncApprovedDecisions(makeStore([makeDecision({
          id: `feed000${index}`,
          title: `Host compatibility ${domain}`,
          proposedRequirement: `The ${domain} domain SHALL preserve schema-valid output.`,
          affectedDomains: [domain],
          affectedFiles: [],
        })]), {
          rootPath: tmpDir,
          openspecPath: join(tmpDir, 'openspec'),
          specMap,
        });
      }
      await syncApprovedDecisions(makeStore([makeDecision({
        id: 'feed0004',
        title: 'Host compatibility deferral',
        proposedRequirement: 'The system SHALL preserve cross-domain compatibility.',
        affectedDomains: domains,
        affectedFiles: [],
      })]), {
        rootPath: tmpDir,
        openspecPath: join(tmpDir, 'openspec'),
        specMap,
      });

      const validation = spawnSync(
        process.execPath,
        [
          join(process.cwd(), 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js'),
          'validate',
          '--specs',
          '--no-interactive',
        ],
        { cwd: tmpDir, encoding: 'utf-8' },
      );
      expect(
        validation.status,
        `${validation.stdout}\n${validation.stderr}`,
      ).toBe(0);
    },
  );

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

  it('preserves supersession authority after sync purges the pending store', async () => {
    const { writeFile } = await import('node:fs/promises');
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    await writeFile(specPath, `${MINIMAL_SPEC.trimEnd()}

### Requirement: DurableDecisionCitation

The system SHALL retain a durable decision citation.

> Corpus edge: spec-cites-decision aaaaaaaa
`, 'utf8');

    const oldDecision = makeDecision({
      id: 'aaaaaaaa',
      title: 'Use the original cache',
      proposedRequirement: null,
    });
    const replacement = makeDecision({
      id: 'bbbbbbbb',
      title: 'Replace the original cache',
      proposedRequirement: null,
      supersedes: oldDecision.id,
    });
    const store = makeStore([oldDecision, replacement]);
    await mkdir(join(tmpDir, '.openlore', 'decisions'), { recursive: true });
    await writeFile(
      join(tmpDir, '.openlore', 'decisions', 'pending.json'),
      JSON.stringify(store, null, 2) + '\n',
      'utf8',
    );

    const before = await detectCorpusIntegrity(tmpDir);
    expect(before).toContainEqual(expect.objectContaining({
      code: 'corpus-target-retired',
      discriminator: 'spec-cites-decision:aaaaaaaa',
      message: expect.stringContaining('cite bbbbbbbb instead'),
    }));

    const { store: persisted } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });
    expect(persisted.decisions).toEqual([]);
    const syncedSpec = await readFile(specPath, 'utf8');
    expect(syncedSpec).toContain('**ID:** bbbbbbbb\n**Supersedes:** aaaaaaaa');

    const after = await detectCorpusIntegrity(tmpDir);
    expect(after).toContainEqual(expect.objectContaining({
      code: 'corpus-target-retired',
      discriminator: 'spec-cites-decision:aaaaaaaa',
      message: expect.stringContaining('cite bbbbbbbb instead'),
    }));
    expect(after.filter((finding) => finding.code === 'corpus-target-retired'))
      .toEqual(before.filter((finding) => finding.code === 'corpus-target-retired'));
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

  it('writes optional supersession metadata to the ADR', async () => {
    const { writeFile, readdir } = await import('node:fs/promises');
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, 'spec.md'), MINIMAL_SPEC, 'utf8');
    await syncApprovedDecisions(makeStore([makeDecision({
      scope: 'system',
      supersedes: '1234abcd',
    })]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });

    const [filename] = await readdir(join(tmpDir, 'openspec', 'decisions'));
    expect(await readFile(join(tmpDir, 'openspec', 'decisions', filename), 'utf8'))
      .toContain('> Supersedes: 1234abcd');
  });

  it('round-trips a decision constraint through the owning spec and ADR before purging', async () => {
    const { writeFile, readdir } = await import('node:fs/promises');
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, 'spec.md'), MINIMAL_SPEC, 'utf8');
    const constraints = {
      version: 1 as const,
      eligibility: {
        status: 'eligible' as const,
        enforcedBoundary: 'Services do not import the CLI.',
        humanReviewRemainder: 'Humans judge semantic alignment.',
      },
      rules: [{
        id: 'services-no-cli',
        scope: 'src/services',
        kind: 'forbidden' as const,
        from: 'src/services',
        to: 'src/cli',
      }],
    };
    await syncApprovedDecisions(makeStore([makeDecision({ scope: 'system', constraints })]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });

    const spec = await readFile(join(specDir, 'spec.md'), 'utf8');
    const [filename] = await readdir(join(tmpDir, 'openspec', 'decisions'));
    const adr = await readFile(join(tmpDir, 'openspec', 'decisions', filename), 'utf8');
    expect(spec).toContain('> OpenLore constraints: {"decisionId":"aaaabbbb"');
    expect(adr).toContain('> OpenLore constraints: {"decisionId":"aaaabbbb"');
    expect(spec).not.toContain('"ruleId"');

    const { loadDecisionConstraintState } = await import('./constraint-ledger.js');
    const state = await loadDecisionConstraintState(tmpDir);
    expect(state.malformedFindings).toEqual([]);
    expect(state.rules).toEqual([
      expect.objectContaining({ ruleId: 'services-no-cli', decision: expect.objectContaining({ id: 'aaaabbbb' }) }),
    ]);
  });

  it('refuses to purge constrained component decisions with no durable target', async () => {
    const constrained = makeDecision({
      scope: 'component',
      affectedDomains: ['missing'],
      constraints: {
        version: 1,
        eligibility: { status: 'eligible', enforcedBoundary: 'A boundary.' },
        rules: [{ id: 'r1', scope: 'src/a', kind: 'forbidden', from: 'src/a', to: 'src/b' }],
      },
    });
    const result = await syncApprovedDecisions(makeStore([constrained]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });
    expect(result.result.errors[0]?.error).toContain('no durable owning spec or ADR target');
    expect(result.result.synced).toEqual([]);
  });

  it('retains a constrained system decision when ADR confinement blocks the only durable write', async () => {
    const outside = await createTempDir();
    await mkdir(join(tmpDir, 'openspec'), { recursive: true });
    await symlink(outside, join(tmpDir, 'openspec', 'decisions'));
    const constrained = makeDecision({
      scope: 'system',
      affectedDomains: ['missing'],
      constraints: {
        version: 1,
        eligibility: { status: 'eligible', enforcedBoundary: 'A boundary.' },
        rules: [{ id: 'r1', scope: 'src/a', kind: 'forbidden', from: 'src/a', to: 'src/b' }],
      },
    });

    const result = await syncApprovedDecisions(makeStore([constrained]), {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap: makeSpecMap('services', 'openspec/specs/services/spec.md'),
    });

    expect(result.result.errors[0]?.error).toContain('no durable projection was written');
    expect(result.result.synced).toEqual([]);
    await rm(outside, { recursive: true, force: true });
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
