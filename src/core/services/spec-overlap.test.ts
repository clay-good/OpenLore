import { describe, expect, it } from 'vitest';

import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import type { SpecLinkIndexSpecInput } from '../generator/spec-link-index.js';
import { buildSpecLinkIndex } from '../generator/spec-link-index.js';
import { computeSpecOverlapObservations } from './spec-overlap.js';

function graph(files: Record<string, string[]>): DependencyGraphResult {
  return {
    nodes: Object.entries(files).map(([path, names]) => ({
      id: path,
      file: { path },
      exports: names.map((name, index) => ({
        name, isDefault: false, isType: false, isReExport: false, kind: 'function', line: index + 1,
      })),
      metrics: { inDegree: 0, outDegree: 0, betweenness: 0, pageRank: 0 },
    })),
    edges: [],
  } as unknown as DependencyGraphResult;
}

const spec = (domain: string, body: string): SpecLinkIndexSpecInput =>
  ({ domain, specFile: `openspec/specs/${domain}/spec.md`, content: body });

const withSources = (files: string[]): string => `# Spec\n\n> Source files: ${files.join(', ')}\n`;

const withAnchor = (requirement: string, anchor: string): string =>
  `### Requirement: ${requirement}\n\nThe system SHALL work.\n- **Implementation**: \`${anchor}\`\n\n`;

describe('computeSpecOverlapObservations', () => {
  it('reports each deterministic overlap of a technical candidate without deciding anything', () => {
    const g = graph({
      'src/components/Agent.tsx': ['AgentPanel'],
      'src/components/Theme.tsx': ['ThemeToggle'],
      'src/components/Artifact.tsx': ['ArtifactFrame'],
    });
    const specs = [
      spec('agent', withSources(['src/components/Agent.tsx'])),
      spec('theme', withSources(['src/components/Theme.tsx'])),
      spec('artifact-rendering', withSources(['src/components/Artifact.tsx'])),
    ];

    const result = computeSpecOverlapObservations({
      candidateDomain: 'components',
      candidateFiles: ['src/components/Agent.tsx', 'src/components/Theme.tsx', 'src/components/Artifact.tsx'],
      graph: g,
      specs,
      linkIndex: null,
    });

    expect(result.observations.map(entry => entry.domain).sort())
      .toEqual(['agent', 'artifact-rendering', 'theme']);
    for (const observation of result.observations) {
      expect(observation.sharedFiles).toHaveLength(1);
      expect(observation.basis).toContain('source-header');
    }
    // Evidence only: nothing here says merge, rename, suppress, or promote.
    expect(JSON.stringify(result)).not.toMatch(/merge|suppress|promote|rename/i);
  });

  it('ranks exact-symbol overlap ahead of file-only overlap', () => {
    const g = graph({ 'src/a.ts': ['alpha'], 'src/b.ts': ['beta'] });
    const specs = [
      spec('fileOnly', withSources(['src/b.ts'])),
      spec('symbolic', `${withSources(['src/a.ts'])}\n${withAnchor('Alpha', 'alpha::src/a.ts')}`),
    ];
    const linkIndex = buildSpecLinkIndex({ specs, graph: g, analysisGeneration: 'gen-1' });

    const result = computeSpecOverlapObservations({
      candidateDomain: 'candidate',
      candidateFiles: ['src/a.ts', 'src/b.ts'],
      graph: g, specs, linkIndex,
    });

    expect(result.observations.map(entry => entry.domain)).toEqual(['symbolic', 'fileOnly']);
    expect(result.observations[0].sharedSymbols).toEqual([{ name: 'alpha', file: 'src/a.ts' }]);
    expect(result.observations[0].basis).toContain('link-index-symbol');
    expect(result.observations[1].sharedSymbols).toEqual([]);
  });

  it('reports an available EMPTY overlap rather than omitting the observation', () => {
    const g = graph({ 'src/a.ts': ['alpha'], 'src/other.ts': ['other'] });
    const result = computeSpecOverlapObservations({
      candidateDomain: 'candidate',
      candidateFiles: ['src/a.ts'],
      graph: g,
      specs: [spec('unrelated', withSources(['src/other.ts']))],
      linkIndex: null,
    });

    expect(result.observations).toEqual([]);
    expect(result.provenance).toMatchObject({ state: 'available', comparedSpecs: 1, complete: true });
  });

  it('does not report a domain as overlapping itself', () => {
    const g = graph({ 'src/a.ts': ['alpha'] });
    const result = computeSpecOverlapObservations({
      candidateDomain: 'billing',
      candidateFiles: ['src/a.ts'],
      graph: g,
      specs: [spec('billing', withSources(['src/a.ts']))],
      linkIndex: null,
    });
    expect(result.observations).toEqual([]);
    expect(result.provenance.comparedSpecs).toBe(0);
  });

  it('discloses incompleteness when a spec declares no canonical footprint', () => {
    const g = graph({ 'src/a.ts': ['alpha'] });
    const result = computeSpecOverlapObservations({
      candidateDomain: 'candidate',
      candidateFiles: ['src/a.ts'],
      graph: g,
      specs: [spec('prose-only', '# Prose\n\nThis spec cites nothing.\n')],
      linkIndex: null,
    });
    expect(result.observations).toEqual([]);
    expect(result.provenance.complete).toBe(false);
  });

  it('ignores a spec reference that escapes the repository', () => {
    const g = graph({ 'src/a.ts': ['alpha'] });
    const result = computeSpecOverlapObservations({
      candidateDomain: 'candidate',
      candidateFiles: ['src/a.ts'],
      graph: g,
      specs: [spec('hostile', withSources(['../../etc/passwd', '/etc/shadow']))],
      linkIndex: null,
    });
    expect(result.observations).toEqual([]);
    expect(result.provenance.complete).toBe(false);
  });

  it('bounds a very large shared set without hiding the true total', () => {
    const files = Array.from({ length: 120 }, (_, i) => `src/m${i}.ts`);
    const g = graph(Object.fromEntries(files.map(file => [file, ['fn']])));
    const result = computeSpecOverlapObservations({
      candidateDomain: 'candidate',
      candidateFiles: files,
      graph: g,
      specs: [spec('wide', withSources(files))],
      linkIndex: null,
    });
    expect(result.observations[0].sharedFiles).toHaveLength(50);
    expect(result.observations[0].sharedFileTotal).toBe(120);
  });
});
