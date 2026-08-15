import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { historicalSpecPaths, prepareSpecGeneration, prepareSpecRepair } from './spec-workflow.js';
import { DEFAULT_RESPONSE_BYTES, EVIDENCE_STREAM_PROTOCOL } from './evidence-stream.js';
import { mappingSourceFingerprint } from '../generator/mapping-generator.js';
import { publishGeneration, REQUIRED_ANALYSIS_ARTIFACTS } from '../runtime/analysis-generation.js';

const roots: string[] = [];

function fixture(fileCount = 12, signaturePad = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'openlore-spec-workflow-'));
  roots.push(root);
  const analysis = join(root, '.openlore', 'analysis');
  mkdirSync(analysis, { recursive: true });
  const files = Array.from({ length: fileCount }, (_, i) => `src/billing/f${String(i).padStart(2, '0')}.ts`);
  writeFileSync(join(analysis, 'repo-structure.json'), JSON.stringify({
    projectName: 'fixture', projectType: 'nodejs', frameworks: [], architecture: { pattern: 'modular', layers: [] },
    domains: [{ name: 'billing', files, definingFiles: files, supportingFiles: [], entities: [], keyFile: files[0] }],
    undomained: [], entryPoints: [], dataFlow: {}, keyFiles: {}, schemas: [], routeInventory: { routes: [] }, statistics: {},
  }));
  writeFileSync(join(analysis, 'dependency-graph.json'), JSON.stringify({
    nodes: files.map((path, i) => ({ id: path, file: { path }, exports: [{ name: `f${i}`, kind: 'function', line: 1, isType: false }] })),
    edges: [], clusters: [], cycles: [], statistics: {},
  }));
  writeFileSync(join(analysis, 'llm-context.json'), JSON.stringify({
    signatures: files.map(path => ({
      path,
      signatures: [`export function ${path.split('/').at(-1)?.replace('.ts', '')}(): void${'/'.repeat(signaturePad)}`],
    })),
    phase2_deep: { files: [] },
  }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('spec workflow composites', () => {
  it('rejects incrementally patched analysis for specification authoring', async () => {
    const root = fixture();
    const analysis = join(root, '.openlore', 'analysis');
    writeFileSync(join(analysis, 'fingerprint.json'), '{}');
    await publishGeneration(analysis, [...REQUIRED_ANALYSIS_ARTIFACTS], { coherence: 'incremental' });

    for (const result of await Promise.all([
      prepareSpecGeneration({ directory: root, domain: 'billing' }),
      prepareSpecRepair({ directory: root, domain: 'billing' }),
    ])) {
      expect(result).toMatchObject({
        receipt: { state: 'unavailable' },
        error: { code: 'analysis-changed', message: expect.stringContaining('full analysis') },
      });
      expect(result.evidence).toBeUndefined();
    }
  });

  it('honors a propagated cancellation signal before reading analysis', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(prepareSpecGeneration({ directory: fixture(), domain: 'billing', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('paginates generation over the evidence stream under a serialized byte budget', async () => {
    const root = fixture(12, 2_000);
    const first = await prepareSpecGeneration({ directory: root, domain: 'billing', maxResponseBytes: 8 * 1024 });

    expect(first.receipt.state).toBe('partial');
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(8 * 1024);
    expect(first.receipt.continuationCursor).toBeDefined();
    expect(first.provenance?.protocol).toBe(EVIDENCE_STREAM_PROTOCOL);
    expect(first.provenance?.responseBytes).toBe(8 * 1024);

    // The whole stream is reachable page by page, with no gaps and no repeats.
    const seen: string[] = [];
    let page = first;
    for (let guard = 0; guard < 50; guard++) {
      for (const section of page.receipt.included) {
        for (const item of page.evidence?.[section] as unknown[]) seen.push(`${section}:${JSON.stringify(item)}`);
      }
      if (!page.receipt.continuationCursor) break;
      page = await prepareSpecGeneration({ directory: root, domain: 'billing', cursor: page.receipt.continuationCursor });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8 * 1024);
    }
    expect(page.receipt.state).toBe('complete');
    expect(page.receipt.omitted).toEqual([]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter(entry => entry.startsWith('domainEvidence:'))).toHaveLength(12);
  });

  it('binds continuations to the full mutable repair composition', async () => {
    const root = fixture(1);
    const specPath = join(root, 'openspec', 'specs', 'billing', 'spec.md');
    mkdirSync(join(root, 'openspec', 'specs', 'billing'), { recursive: true });
    writeFileSync(specPath, `# Billing\n\n${'original evidence\n'.repeat(2_000)}`);
    const first = await prepareSpecRepair({ directory: root, domain: 'billing', maxItems: 10, maxResponseBytes: 8 * 1024 });
    expect(first.receipt.continuationCursor).toBeDefined();

    writeFileSync(specPath, `# Billing\n\n${'changed evidence\n'.repeat(2_000)}`);
    const changed = await prepareSpecRepair({
      directory: root, domain: 'billing', maxItems: 10,
      cursor: first.receipt.continuationCursor,
    });
    expect(changed.error?.code).toBe('analysis-changed');
  });

  it('binds repair shaping arguments and emits an executable continuation', async () => {
    const root = fixture(1);
    mkdirSync(join(root, 'openspec', 'specs', 'billing'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'specs', 'billing', 'spec.md'), `# Billing\n\n${'evidence\n'.repeat(2_000)}`);
    const first = await prepareSpecRepair({ directory: root, domain: 'billing', baseRef: 'HEAD', maxItems: 10, maxResponseBytes: 8 * 1024 });
    const follow = first.receipt.followUps.find(item => item.tool === 'prepare_spec_repair')!;
    expect(follow.arguments).toMatchObject({
      cursor: first.receipt.continuationCursor,
      baseRef: 'HEAD',
      maxItems: 10,
      maxResponseBytes: 8 * 1024,
    });
    const reshaped = await prepareSpecRepair({
      directory: root, domain: 'billing', baseRef: 'auto', maxItems: 10,
      cursor: first.receipt.continuationCursor,
    });
    expect(reshaped.error?.code).toBe('analysis-changed');
  });

  it('enforces maxItems as a cross-section page limit', async () => {
    const page = await prepareSpecGeneration({ directory: fixture(25), domain: 'billing', maxItems: 10 });
    const delivered = page.receipt.included.reduce(
      (count, section) => count + ((page.evidence?.[section] as unknown[] | undefined)?.length ?? 0), 0,
    );
    expect(delivered).toBeLessThanOrEqual(10);
    expect(page.receipt.state).toBe('partial');
  });

  it('unconditionally redacts repository evidence before enforcing the wire budget', async () => {
    const root = fixture(20, 300);
    mkdirSync(join(root, '.openlore'), { recursive: true });
    writeFileSync(join(root, '.openlore', 'config.json'), JSON.stringify({ secretRedaction: { toolOutput: false } }));
    const contextPath = join(root, '.openlore', 'analysis', 'llm-context.json');
    const context = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(contextPath))));
    context.signatures[0].signatures[0] += ' password=abcdefgh';
    writeFileSync(contextPath, JSON.stringify(context));
    const result = await prepareSpecGeneration({ directory: root, domain: 'billing', maxResponseBytes: 8 * 1024 });
    expect(JSON.stringify(result)).not.toContain('password=abcdefgh');
    expect(result.redactions?.count).toBeGreaterThan(0);
    expect(result.evidence?.contentSafety).toMatch(/untrusted repository source content/i);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8 * 1024);
  });

  it('declares complete only when the whole stream fits one within-budget envelope', async () => {
    const only = await prepareSpecGeneration({ directory: fixture(2), domain: 'billing' });
    expect(only.receipt.state).toBe('complete');
    expect(only.receipt.continuationCursor).toBeUndefined();
    expect(only.receipt.omitted).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(only))).toBeLessThanOrEqual(DEFAULT_RESPONSE_BYTES);
  });

  it('offers the same composite as the continuation, never an unavailable atomic tool', async () => {
    const first = await prepareSpecGeneration({
      directory: fixture(12, 2_000), domain: 'billing', maxResponseBytes: 8 * 1024,
    });
    expect(first.receipt.followUps).toHaveLength(1);
    expect(first.receipt.followUps[0].tool).toBe('prepare_spec_generation');
  });

  it('rejects unknown domains without substituting repository evidence', async () => {
    const result = await prepareSpecGeneration({ directory: fixture(), domain: 'typo' });
    expect(result).toMatchObject({ receipt: { state: 'unavailable' }, error: { code: 'unknown-domain', availableDomains: ['billing'] } });
    expect(result.evidence).toBeUndefined();
  });

  it('resolves generation domains case-insensitively and returns the canonical name', async () => {
    const result = await prepareSpecGeneration({ directory: fixture(2), domain: 'BILLING' });
    expect(result.error).toBeUndefined();
    expect(result.domain).toEqual({ requested: 'BILLING', resolved: 'billing' });
  });

  it('reports an indivisible oversized record instead of dropping the section', async () => {
    const root = fixture(1);
    const contextPath = join(root, '.openlore', 'analysis', 'llm-context.json');
    const context = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(contextPath))));
    context.signatures[0].signatures = [`export type Huge = '${'x'.repeat(300_000)}'`];
    writeFileSync(contextPath, JSON.stringify(context));

    // The first page still delivers what it can and hands back a cursor; the
    // indivisible record is reported when the stream reaches it, never dropped.
    const first = await prepareSpecGeneration({ directory: root, domain: 'billing', maxResponseBytes: 8 * 1024 });
    expect(first.receipt.state).toBe('partial');
    expect(first.receipt.omitted).toContainEqual(expect.objectContaining({ section: 'signatures' }));

    const next = await prepareSpecGeneration({ directory: root, domain: 'billing', cursor: first.receipt.continuationCursor });
    expect(next.error?.code).toBe('response-too-large');
    expect(next.error?.message).toContain('signatures');
    expect(next.receipt.state).toBe('unavailable');
  });

  it('continues INSIDE a section so one huge file cannot hide the rest of the stream', async () => {
    const root = fixture(3, 3_000);
    const first = await prepareSpecGeneration({ directory: root, domain: 'billing', maxResponseBytes: 8 * 1024 });
    let page = first;
    const sections = new Set<string>();
    for (let guard = 0; guard < 50 && page.receipt.continuationCursor; guard++) {
      page.receipt.included.forEach(section => sections.add(section));
      page = await prepareSpecGeneration({ directory: root, domain: 'billing', cursor: page.receipt.continuationCursor });
    }
    page.receipt.included.forEach(section => sections.add(section));
    expect(sections).toContain('domainEvidence');
    expect(sections).toContain('signatures');
    expect(page.receipt.state).toBe('complete');
  });

  it('rejects a cursor after analysis provenance changes', async () => {
    const root = fixture(12, 2_000);
    const first = await prepareSpecGeneration({ directory: root, domain: 'billing', maxResponseBytes: 8 * 1024 });
    const graphPath = join(root, '.openlore', 'analysis', 'dependency-graph.json');
    const graph = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(graphPath))));
    graph.nodes[0].exports[0].name = 'changed';
    writeFileSync(graphPath, JSON.stringify(graph));
    const result = await prepareSpecGeneration({ directory: root, domain: 'billing', cursor: first.receipt.continuationCursor });
    expect(result.error?.code).toBe('analysis-changed');
  });

  it('rejects a cursor when domain membership changes without export changes', async () => {
    const root = fixture(12, 2_000);
    const first = await prepareSpecGeneration({ directory: root, domain: 'billing', maxResponseBytes: 8 * 1024 });
    const repoPath = join(root, '.openlore', 'analysis', 'repo-structure.json');
    const repo = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(repoPath))));
    repo.domains[0].supportingFiles = ['src/billing/new-support.test.ts'];
    repo.domains[0].files.push('src/billing/new-support.test.ts');
    writeFileSync(repoPath, JSON.stringify(repo));
    const result = await prepareSpecGeneration({ directory: root, domain: 'billing', cursor: first.receipt.continuationCursor });
    expect(result.error?.code).toBe('analysis-changed');
  });

  it('rejects a forged cursor rather than serving an arbitrary window', async () => {
    const root = fixture(12, 2_000);
    const first = await prepareSpecGeneration({ directory: root, domain: 'billing', maxResponseBytes: 8 * 1024 });
    const decoded = JSON.parse(Buffer.from(first.receipt.continuationCursor!, 'base64url').toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...decoded, o: 0 })).toString('base64url');
    const result = await prepareSpecGeneration({ directory: root, domain: 'billing', cursor: forged });
    expect(result.error?.code).toBe('analysis-changed');
  });

  it('rejects a cursor replayed against a different domain', async () => {
    const root = fixture(12, 2_000);
    const first = await prepareSpecGeneration({ directory: root, domain: 'billing', maxResponseBytes: 8 * 1024 });
    const result = await prepareSpecGeneration({ directory: root, domain: 'typo', cursor: first.receipt.continuationCursor });
    expect(result.error?.code).toBe('unknown-domain');
  });

  it('binds continuation cursors to the canonical domain across casing changes', async () => {
    const root = fixture(12, 2_000);
    const repoPath = join(root, '.openlore', 'analysis', 'repo-structure.json');
    const repo = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(repoPath))));
    repo.domains.push({ name: 'orders', files: [], definingFiles: [], supportingFiles: [] });
    repo.domainDecisions = Array.from({ length: 30 }, (_, index) => ({
      candidate: `billing-${index}-${'x'.repeat(500)}`,
      path: 'src/billing', sources: ['directory'], disposition: 'promoted',
      reason: 'ownership-root', owner: 'billing', files: [],
    }));
    writeFileSync(repoPath, JSON.stringify(repo));

    const first = await prepareSpecGeneration({ directory: root, domain: 'BILLING', maxResponseBytes: 8 * 1024 });
    const continued = await prepareSpecGeneration({ directory: root, domain: 'billing', cursor: first.receipt.continuationCursor });
    expect(continued.error).toBeUndefined();
    expect(continued.domain).toEqual({ requested: 'billing', resolved: 'billing' });

    const switched = await prepareSpecGeneration({ directory: root, domain: 'orders', cursor: first.receipt.continuationCursor });
    expect(switched.error?.code).toBe('analysis-changed');
  });

  it('extracts historical source paths without guessing prose', () => {
    expect(historicalSpecPaths('> Source files: `./src/old.ts`, src\\moved.ts\n\n**Implementation**: `src/service.ts`\n\nExample: `other-domain.ts`'))
      .toEqual(['src/moved.ts', 'src/old.ts', 'src/service.ts']);
  });

  it('pages an oversized repair response instead of clipping it', async () => {
    const root = fixture(1);
    const analysis = join(root, '.openlore', 'analysis');
    const repoPath = join(analysis, 'repo-structure.json');
    const repo = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(repoPath))));
    repo.domainDecisions = Array.from({ length: 500 }, (_, index) => ({
      candidate: `billing-${index}-${'x'.repeat(600)}`,
      path: 'src/billing', sources: ['directory'], disposition: 'promoted', reason: 'ownership-root', owner: 'billing', files: ['src/billing/f00.ts'],
    }));
    writeFileSync(repoPath, JSON.stringify(repo));
    const graph = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(join(analysis, 'dependency-graph.json')))));
    writeFileSync(join(analysis, 'mapping.json'), JSON.stringify({
      version: 2, generatedAt: new Date().toISOString(), sourceAnalysisFingerprint: mappingSourceFingerprint(graph),
      mappings: [], orphanFunctions: [], stats: {},
    }));
    mkdirSync(join(root, 'openspec', 'specs', 'billing'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'specs', 'billing', 'spec.md'), '# Billing\n\n> Source files: src/billing/f00.ts\n');
    const result = await prepareSpecRepair({ directory: root, domain: 'billing', maxResponseBytes: 8 * 1024 });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8 * 1024);
    expect(result.receipt.state).not.toBe('complete');
    expect(result.receipt.continuationCursor).toBeDefined();
    expect(result.receipt.followUps[0].tool).toBe('prepare_spec_repair');
  });

  // Three full repair passes, each running git plumbing and a structural diff, put
  // this case at the default 5s bound on slower machines; the work is inherent.
  it('repairs an orphaned spec and retains a deleted historical path in structural scope', { timeout: 30_000 }, async () => {
    const root = fixture(1);
    const analysis = join(root, '.openlore', 'analysis');
    const oldPath = 'src/legacy.ts';
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, oldPath), 'export function legacy(): void {}\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@example.test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'baseline', '--no-gpg-sign'], { cwd: root });
    unlinkSync(join(root, oldPath));

    const graph = { nodes: [{ id: oldPath, file: { path: oldPath }, exports: [{ name: 'legacy', kind: 'function', line: 1, isType: false }] }], edges: [], clusters: [], cycles: [], statistics: {} };
    writeFileSync(join(analysis, 'dependency-graph.json'), JSON.stringify(graph));
    writeFileSync(join(analysis, 'repo-structure.json'), JSON.stringify({
      projectName: 'fixture', projectType: 'nodejs', frameworks: [], architecture: { pattern: 'modular', layers: [] },
      domains: [], undomained: [], entryPoints: [], dataFlow: {}, keyFiles: {}, schemas: [], routeInventory: { routes: [] }, statistics: {},
    }));
    writeFileSync(join(analysis, 'llm-context.json'), JSON.stringify({ signatures: [], phase2_deep: { files: [] }, callGraph: { nodes: [], edges: [], entryPoints: [], hubFunctions: [], layerViolations: [], inheritanceEdges: [], classes: [], stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 } } }));
    writeFileSync(join(analysis, 'mapping.json'), JSON.stringify({
      version: 2, generatedAt: new Date().toISOString(), sourceAnalysisFingerprint: mappingSourceFingerprint(graph as never),
      mappings: [{ requirement: 'Legacy', service: 'Legacy', domain: 'legacy', specFile: 'openspec/specs/legacy/spec.md', functions: [{ name: 'legacy', file: oldPath, line: 1, kind: 'function', confidence: 'llm' }] }],
      orphanFunctions: [], stats: { totalRequirements: 1, mappedRequirements: 1, totalExportedFunctions: 1, orphanCount: 0 },
    }));
    mkdirSync(join(root, 'openspec', 'specs', 'legacy'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'specs', 'legacy', 'spec.md'), `# Legacy\n\n> Source files: \`${oldPath}\`\n\n## Requirements\n`);

    const result = await prepareSpecRepair({ directory: root, domain: 'legacy', baseRef: 'HEAD' });
    expect(result.error).toBeUndefined();
    expect(result.evidence?.domainEvidenceCoverage).toMatchObject({ state: 'unavailable', possibleOrphan: true });
    expect(result.evidence?.structuralScope).toContain(oldPath);
    expect(JSON.stringify(result.evidence?.structuralChange ?? [])).toContain('legacy');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(220 * 1024);
    expect(existsSync(join(analysis, 'audit-report.json'))).toBe(false);
    expect(existsSync(join(analysis, 'spec-snapshot.json'))).toBe(false);

    // Repair must work with no mapping cache at all: the links are re-derived from
    // the spec on disk plus the current graph, so coverage stays available.
    unlinkSync(join(analysis, 'mapping.json'));
    const missing = await prepareSpecRepair({ directory: root, domain: 'legacy', baseRef: 'HEAD' });
    // Repair audits one domain, so the global cache is deliberately not consulted;
    // what matters is that the absent cache did not cost availability.
    expect(missing.evidence?.mappingCoverage).toMatchObject({ state: 'available', source: 'derived' });
    expect(missing.evidence?.existingSpecMeta).toMatchObject({ domain: 'legacy' });
    expect(missing.receipt.omitted.map(entry => entry.section)).not.toContain('uncoveredFunction');
    // Read-only Repair must not write the cache it declined to read.
    expect(existsSync(join(analysis, 'mapping.json'))).toBe(false);

    // A corrupt cache is reported, never trusted, and never fatal.
    writeFileSync(join(analysis, 'mapping.json'), '{invalid');
    const invalid = await prepareSpecRepair({ directory: root, domain: 'legacy', baseRef: 'HEAD' });
    expect(invalid.evidence?.mappingCoverage).toMatchObject({ state: 'available', source: 'derived' });
    expect(invalid.evidence?.existingSpecMeta).toMatchObject({ domain: 'legacy' });
  });

  it('resolves repair spec domains case-insensitively and returns the canonical name', async () => {
    const root = fixture(1);
    mkdirSync(join(root, 'openspec', 'specs', 'billing'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'specs', 'billing', 'spec.md'), '# Billing\n');

    const result = await prepareSpecRepair({ directory: root, domain: 'BILLING' });
    expect(result.error).toBeUndefined();
    expect(result.domain).toEqual({ requested: 'BILLING', resolved: 'billing' });
  });

  it('uses spec casing as the canonical repair and mapping identity', async () => {
    const root = fixture(1);
    const repoPath = join(root, '.openlore', 'analysis', 'repo-structure.json');
    const repo = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(repoPath))));
    repo.domains[0].name = 'Billing';
    writeFileSync(repoPath, JSON.stringify(repo));
    mkdirSync(join(root, 'openspec', 'specs', 'billing'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'specs', 'billing', 'spec.md'),
      '# Billing\n\n### Requirement: Runs F0\n\n- **Implementation**: `f0::src/billing/f00.ts`\n');
    const result = await prepareSpecRepair({ directory: root, domain: 'BILLING' });
    expect(result.domain.resolved).toBe('billing');
    expect(JSON.stringify(result.evidence?.coveredFunction ?? [])).toContain('f0');
  });

  it('reports an empty historical footprint as unavailable', async () => {
    const root = fixture(1);
    mkdirSync(join(root, 'openspec', 'specs', 'legacy'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'specs', 'legacy', 'spec.md'), '# Legacy\n');
    const result = await prepareSpecRepair({ directory: root, domain: 'legacy' });
    expect(result.evidence?.structuralChangeSummary).toEqual({
      state: 'unavailable', reason: 'empty-historical-footprint',
    });
  });

  it('binds repair cursors to the canonical domain without making casing significant', async () => {
    const root = fixture(12, 2_000);
    const repoPath = join(root, '.openlore', 'analysis', 'repo-structure.json');
    const repo = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(repoPath))));
    repo.domains.push({ name: 'orders', files: [], definingFiles: [], supportingFiles: [] });
    repo.domainDecisions = Array.from({ length: 30 }, (_, index) => ({
      candidate: `billing-${index}-${'x'.repeat(500)}`,
      path: 'src/billing', sources: ['directory'], disposition: 'promoted',
      reason: 'ownership-root', owner: 'billing', files: [],
    }));
    writeFileSync(repoPath, JSON.stringify(repo));
    for (const domain of ['billing', 'orders']) {
      mkdirSync(join(root, 'openspec', 'specs', domain), { recursive: true });
      writeFileSync(join(root, 'openspec', 'specs', domain, 'spec.md'), `# ${domain}\n`);
    }

    const first = await prepareSpecRepair({ directory: root, domain: 'BILLING', maxResponseBytes: 8 * 1024 });
    expect(first.receipt.continuationCursor).toBeDefined();
    const continued = await prepareSpecRepair({ directory: root, domain: 'billing', cursor: first.receipt.continuationCursor });
    expect(continued.error).toBeUndefined();
    expect(continued.domain).toEqual({ requested: 'billing', resolved: 'billing' });

    const switched = await prepareSpecRepair({ directory: root, domain: 'orders', cursor: first.receipt.continuationCursor });
    expect(switched.error?.code).toBe('analysis-changed');
  });

  it('withholds coverage metrics for a spec outside the link corpus', async () => {
    // `overview` is a structural document that owns no source files, so it is
    // excluded from the link corpus. Repair still serves the spec, but must report
    // coverage as unavailable rather than as an observed zero.
    const root = fixture(1);
    mkdirSync(join(root, 'openspec', 'specs', 'overview'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'specs', 'overview', 'spec.md'), '# Overview\n\n### Requirement: Describes The System\n');

    const result = await prepareSpecRepair({ directory: root, domain: 'overview' });
    expect(result.evidence?.mappingCoverage).toMatchObject({
      state: 'unavailable', reason: 'specs-unavailable',
    });
    const summary = result.evidence?.coverageSummary as Record<string, unknown>;
    expect(summary.coveredFunctions).toBeNull();
    expect(summary.coveragePct).toBeNull();
    expect(summary.uncoveredCount).toBeNull();
    // Coverage-dependent sections are WITHHELD (not deferred): no cursor can recover
    // an observation that could not be established.
    expect(result.receipt.omitted).toContainEqual(expect.objectContaining({
      section: 'uncoveredFunction', reason: 'mapping-specs-unavailable',
    }));
    expect(result.receipt.omitted.find(item => item.section === 'uncoveredFunction'))
      .not.toHaveProperty('omittedCount');
    expect(result.receipt.included).not.toContain('uncoveredFunction');
    expect(result.receipt.state).toBe('partial');
  });

  it('counts the whole coverage gap, not the bounded page of it', async () => {
    // The uncovered LIST is capped at maxItems. Deriving the counts from that page
    // would report a bounded sample as if it were the whole gap.
    const root = fixture(12);
    const analysis = join(root, '.openlore', 'analysis');
    const files = Array.from({ length: 12 }, (_, i) => `src/billing/f${String(i).padStart(2, '0')}.ts`);
    const context = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(join(analysis, 'llm-context.json')))));
    context.callGraph = {
      nodes: files.map((path, i) => ({
        id: `${path}::f${i}`, name: `f${i}`, filePath: path, line: 1, fanIn: 0, fanOut: 0,
      })),
      edges: [], entryPoints: [], hubFunctions: [], layerViolations: [], inheritanceEdges: [], classes: [],
      stats: { totalNodes: 12, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
    };
    writeFileSync(join(analysis, 'llm-context.json'), JSON.stringify(context));
    mkdirSync(join(root, 'openspec', 'specs', 'billing'), { recursive: true });
    writeFileSync(
      join(root, 'openspec', 'specs', 'billing', 'spec.md'),
      '# Billing\n\n### Requirement: Charges Are Booked\n\nThe system SHALL book charges.\n\n'
      + `- **Implementation**: \`f0::${files[0]}\`\n`,
    );

    const result = await prepareSpecRepair({ directory: root, domain: 'billing', maxItems: 10 });
    const summary = result.evidence?.coverageSummary as Record<string, unknown>;
    expect(result.evidence?.mappingCoverage).toMatchObject({ state: 'available' });
    expect(summary.totalFunctions).toBe(12);
    expect(summary.coveredFunctions).toBe(1);
    // 11 uncovered, of which only the first 10 can ride in the bounded list.
    expect(summary.uncoveredCount).toBe(11);
    expect(summary.coveragePct).toBe(8);
  });

  it('remediates unavailable mapping with an exact command, never a repeat of the same audit', async () => {
    const root = fixture(1);
    mkdirSync(join(root, 'openspec', 'specs', 'overview'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'specs', 'overview', 'spec.md'), '# Overview\n\n### Requirement: Describes The System\n');

    const result = await prepareSpecRepair({ directory: root, domain: 'overview' });
    const tools = result.receipt.followUps.map(followUp => followUp.tool);
    expect(tools).not.toContain('audit_spec_coverage');
    expect(tools.some(tool => tool.startsWith('cli:') || tool.startsWith('edit:'))).toBe(true);
  });
});
