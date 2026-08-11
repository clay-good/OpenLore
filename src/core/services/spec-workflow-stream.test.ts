import { describe, expect, it } from 'vitest';

import type { RepoStructure } from '../analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import type { DomainEvidenceBundle } from '../generator/domain-evidence.js';
import {
  GENERATION_STREAM_SECTIONS,
  REPAIR_STREAM_SECTIONS,
  SPEC_SEGMENT_CHARS,
  buildGenerationStream,
  buildRepairStream,
  segmentSpecContent,
  structuralChangeRecords,
  structuralChangeSummary,
} from './spec-workflow-stream.js';

const emptyBundle: DomainEvidenceBundle = {
  name: 'billing',
  files: [], definingFiles: [], supportingFiles: [], candidateDecisions: [],
  schemaFiles: [], serviceFiles: [], apiFiles: [],
  signatures: [], supportingSignatures: [], schemas: [], routes: [],
};

const emptyRepo = {} as RepoStructure;
const emptyGraph = { nodes: [], edges: [] } as unknown as DependencyGraphResult;

// ============================================================================
// PROTOCOL ORDER
// ============================================================================

describe('stream section order', () => {
  // A cursor is a SECTION INDEX plus an offset, so the built stream must agree
  // with the declared order exactly. If these drift, every outstanding cursor
  // silently resumes in the wrong section.
  it('generation stream matches its declared section order', () => {
    const built = buildGenerationStream({
      root: '/repo', bundle: emptyBundle, repo: emptyRepo, graph: emptyGraph, overlap: [],
    });
    expect(built.map(section => section.section)).toEqual([...GENERATION_STREAM_SECTIONS]);
  });

  it('repair stream matches its declared section order', () => {
    const built = buildRepairStream({
      specContent: '', coveredFunction: [], uncoveredFunction: [], staleMapping: [],
      orphanRequirement: [], structuralChange: [], drift: [], domainMembership: [],
      candidateDecisions: [],
    });
    expect(built.map(section => section.section)).toEqual([...REPAIR_STREAM_SECTIONS]);
  });

  it('declares no duplicate section names', () => {
    expect(new Set(GENERATION_STREAM_SECTIONS).size).toBe(GENERATION_STREAM_SECTIONS.length);
    expect(new Set(REPAIR_STREAM_SECTIONS).size).toBe(REPAIR_STREAM_SECTIONS.length);
  });
});

// ============================================================================
// SPEC SEGMENTATION
// ============================================================================

describe('segmentSpecContent', () => {
  it('splits a large spec into ordered, contiguous segments', () => {
    const content = 'x'.repeat(SPEC_SEGMENT_CHARS * 2 + 10);
    const segments = segmentSpecContent(content);
    expect(segments).toHaveLength(3);
    expect(segments.map(segment => segment.index)).toEqual([0, 1, 2]);
    expect(segments.map(segment => segment.text).join('')).toBe(content);
  });

  it('keeps a small spec as one segment', () => {
    expect(segmentSpecContent('# Spec')).toEqual([{ index: 0, text: '# Spec' }]);
  });

  it('returns no segments for an empty spec', () => {
    expect(segmentSpecContent('')).toEqual([]);
  });
});

// ============================================================================
// STRUCTURAL CHANGE FLATTENING
// ============================================================================

describe('structuralChangeRecords', () => {
  it('flattens every parallel list into one pageable, kind-tagged section', () => {
    const records = structuralChangeRecords({
      changedFiles: [{ path: 'a.ts', status: 'modified' }],
      added: [{ name: 'newFn', file: 'a.ts' }],
      removed: [{ name: 'goneFn', file: 'a.ts' }],
      signatureChanged: [{ name: 'changedFn', file: 'a.ts' }],
      renameCandidates: [{ from: 'x', to: 'y' }],
      edges: { added: [{ caller: 'a', callee: 'b' }], removed: [{ caller: 'c', callee: 'd' }] },
    });
    expect(records.map(record => (record as { kind: string }).kind)).toEqual([
      'changedFile', 'added', 'removed', 'signatureChanged', 'renameCandidate', 'addedEdge', 'removedEdge',
    ]);
  });

  it('is empty for an unavailable or malformed diff rather than throwing', () => {
    expect(structuralChangeRecords(null)).toEqual([]);
    expect(structuralChangeRecords({ error: 'Not a git repository.' })).toEqual([]);
    expect(structuralChangeRecords('nonsense')).toEqual([]);
  });
});

describe('structuralChangeSummary', () => {
  it('keeps the scalar summary page-global', () => {
    expect(structuralChangeSummary({
      base: 'HEAD', head: 'working tree', summary: { addedFunctions: 2 }, soundness: { posture: 'x', caveats: [] },
    })).toMatchObject({ state: 'available', base: 'HEAD', summary: { addedFunctions: 2 } });
  });

  it('reports an error result as unavailable with its reason', () => {
    expect(structuralChangeSummary({ error: 'Not a git repository.' }))
      .toEqual({ state: 'unavailable', reason: 'Not a git repository.' });
  });
});
