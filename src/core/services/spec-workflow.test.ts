import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { historicalSpecPaths, prepareSpecGeneration, prepareSpecRepair, SPEC_WORKFLOW_SECTIONS } from './spec-workflow.js';
import { mappingSourceFingerprint } from '../generator/mapping-generator.js';

const roots: string[] = [];

function fixture(fileCount = 12): string {
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
    signatures: files.map(path => ({ path, signatures: [`export function ${path.split('/').at(-1)?.replace('.ts', '')}(): void`] })),
    phase2_deep: { files: [] },
  }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('spec workflow composites', () => {
  it('honors a propagated cancellation signal before reading analysis', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(prepareSpecGeneration({ directory: fixture(), domain: 'billing', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('paginates generation deterministically with an explicit receipt', async () => {
    const root = fixture();
    const first = await prepareSpecGeneration({ directory: root, domain: 'billing', maxItems: 10 });
    expect(first.receipt).toMatchObject({ state: 'partial', included: [...SPEC_WORKFLOW_SECTIONS.generation] });
    expect(first.receipt.omitted).toEqual([{ section: 'domainEvidence', reason: 'response-budget', omittedCount: 2 }]);
    expect(JSON.stringify(first).length).toBeLessThan(100_000);
    expect(first.evidence?.domainEvidence).toMatchObject({ name: 'billing', definingFiles: expect.any(Array), supportingFiles: [] });
    const second = await prepareSpecGeneration({ directory: root, domain: 'billing', cursor: first.receipt.continuationCursor });
    expect(second.receipt.state).toBe('complete');
    expect(second.evidence?.partition).toMatchObject({ offset: 10, count: 2, total: 12 });
  });

  it('rejects unknown domains without substituting repository evidence', async () => {
    const result = await prepareSpecGeneration({ directory: fixture(), domain: 'typo' });
    expect(result).toMatchObject({ receipt: { state: 'unavailable' }, error: { code: 'unknown-domain', availableDomains: ['billing'] } });
    expect(result.evidence).toBeUndefined();
  });

  it('bounds an oversized single-file partition with explicit atomic follow-up', async () => {
    const root = fixture(1);
    const contextPath = join(root, '.openlore', 'analysis', 'llm-context.json');
    const context = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(contextPath))));
    context.signatures[0].signatures = [`export type Huge = '${'x'.repeat(300_000)}'`];
    writeFileSync(contextPath, JSON.stringify(context));
    const result = await prepareSpecGeneration({ directory: root, domain: 'billing' });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(220 * 1024);
    expect(result.receipt).toMatchObject({ state: 'partial', omitted: expect.arrayContaining([expect.objectContaining({ section: 'signatures' })]) });
    expect(result.receipt.followUps).toContainEqual(expect.objectContaining({
      tool: 'get_signatures', arguments: expect.objectContaining({ filePattern: 'src/billing/f00.ts' }),
    }));
  });

  it('rejects a cursor after analysis provenance changes', async () => {
    const root = fixture();
    const first = await prepareSpecGeneration({ directory: root, domain: 'billing', maxItems: 10 });
    const graphPath = join(root, '.openlore', 'analysis', 'dependency-graph.json');
    const graph = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(graphPath))));
    graph.nodes[0].exports[0].name = 'changed';
    writeFileSync(graphPath, JSON.stringify(graph));
    const result = await prepareSpecGeneration({ directory: root, domain: 'billing', cursor: first.receipt.continuationCursor });
    expect(result.error?.code).toBe('analysis-changed');
  });

  it('rejects a cursor when domain membership changes without export changes', async () => {
    const root = fixture();
    const first = await prepareSpecGeneration({ directory: root, domain: 'billing', maxItems: 10 });
    const repoPath = join(root, '.openlore', 'analysis', 'repo-structure.json');
    const repo = JSON.parse(String(await import('node:fs/promises').then(fs => fs.readFile(repoPath))));
    repo.domains[0].supportingFiles = ['src/billing/new-support.test.ts'];
    repo.domains[0].files.push('src/billing/new-support.test.ts');
    writeFileSync(repoPath, JSON.stringify(repo));
    const result = await prepareSpecGeneration({ directory: root, domain: 'billing', cursor: first.receipt.continuationCursor });
    expect(result.error?.code).toBe('analysis-changed');
  });

  it('extracts historical source paths without guessing prose', () => {
    expect(historicalSpecPaths('> Source files: `./src/old.ts`, src\\moved.ts\n\n**Implementation**: `src/service.ts`\n\nExample: `other-domain.ts`'))
      .toEqual(['src/moved.ts', 'src/old.ts', 'src/service.ts']);
  });

  it('keeps an oversized repair response within the absolute byte bound', async () => {
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
    const result = await prepareSpecRepair({ directory: root, domain: 'billing' });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(220 * 1024);
    expect(result.receipt.state).not.toBe('complete');
    expect(result.receipt.omitted).toContainEqual(expect.objectContaining({ section: 'domainEvidence' }));
  });

  it('repairs an orphaned spec and retains a deleted historical path in structural scope', async () => {
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
    expect(JSON.stringify(result.evidence?.structuralChange)).toContain('legacy');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(220 * 1024);
    expect(existsSync(join(analysis, 'audit-report.json'))).toBe(false);
    expect(existsSync(join(analysis, 'spec-snapshot.json'))).toBe(false);

    unlinkSync(join(analysis, 'mapping.json'));
    const missing = await prepareSpecRepair({ directory: root, domain: 'legacy', baseRef: 'HEAD' });
    expect(missing.evidence?.mappingCoverage).toMatchObject({ state: 'missing' });
    expect(missing.evidence?.existingSpec).toMatchObject({ domain: 'legacy' });
    expect(missing.receipt.state).toBe('partial');
    expect((missing.evidence?.observations as Record<string, unknown>).uncoveredFunction).toBeNull();
    expect(missing.receipt.included).not.toContain('uncoveredFunction');

    writeFileSync(join(analysis, 'mapping.json'), '{invalid');
    const invalid = await prepareSpecRepair({ directory: root, domain: 'legacy', baseRef: 'HEAD' });
    expect(invalid.evidence?.mappingCoverage).toMatchObject({ state: 'invalid' });
    expect(invalid.evidence?.existingSpec).toMatchObject({ domain: 'legacy' });
  });
});
