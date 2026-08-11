import { describe, expect, it } from 'vitest';

import type { DependencyGraphResult, DependencyNode } from '../analyzer/dependency-graph.js';
import { parseRequirementBlocks } from '../drift/spec-mapper.js';
import {
  SPEC_LINK_INDEX_VERSION,
  buildSpecLinkIndex,
  isLinkIndexCurrent,
  normalizeAnchorPath,
  parseSpecAnchor,
  readMappingArtifact,
  specCorpusDigest,
  type SpecLinkIndexSpecInput,
} from './spec-link-index.js';

// ============================================================================
// FIXTURES
// ============================================================================

type ExportFixture = { name: string; line?: number; kind?: string; isType?: boolean };

function node(path: string, exports: ExportFixture[]): DependencyNode {
  return {
    id: path,
    file: { path } as DependencyNode['file'],
    exports: exports.map(item => ({
      name: item.name,
      isDefault: false,
      isType: item.isType ?? false,
      isReExport: false,
      kind: (item.kind ?? 'function') as 'function',
      line: item.line ?? 1,
    })),
    metrics: { inDegree: 0, outDegree: 0, betweenness: 0, pageRank: 0 },
  } as DependencyNode;
}

function graph(...nodes: DependencyNode[]): DependencyGraphResult {
  return { nodes, edges: [] } as unknown as DependencyGraphResult;
}

function spec(requirement: string, anchors: string[], extra = ''): string {
  const implementation = anchors.length > 0
    ? `\n- **Implementation**: ${anchors.map(a => `\`${a}\``).join(', ')}\n`
    : '\n';
  return `# Domain Specification\n\n### Requirement: ${requirement}\n\nThe system SHALL do the thing.\n${implementation}${extra}\n#### Scenario: It works\n- **WHEN** invoked\n- **THEN** it works\n`;
}

const specInput = (content: string, domain = 'auth'): SpecLinkIndexSpecInput[] =>
  [{ domain, specFile: `openspec/specs/${domain}/spec.md`, content }];

const build = (specs: SpecLinkIndexSpecInput[], g: DependencyGraphResult) =>
  buildSpecLinkIndex({ specs, graph: g, analysisGeneration: 'gen-1', now: () => new Date('2026-01-01T00:00:00.000Z') });

// ============================================================================
// ANCHOR PARSING
// ============================================================================

describe('parseSpecAnchor', () => {
  it('parses the house name::path form', () => {
    expect(parseSpecAnchor('createSession::src/auth/session.ts'))
      .toEqual({ file: 'src/auth/session.ts', symbol: 'createSession' });
  });

  it('parses the path#symbol form', () => {
    expect(parseSpecAnchor('src/auth/session.ts#createSession'))
      .toEqual({ file: 'src/auth/session.ts', symbol: 'createSession' });
  });

  it('parses a file-only anchor with no symbol', () => {
    expect(parseSpecAnchor('src/auth/session.ts')).toEqual({ file: 'src/auth/session.ts', symbol: null });
  });

  it('parses a bare identifier as a path-free symbol anchor', () => {
    expect(parseSpecAnchor('createSession')).toEqual({ file: null, symbol: 'createSession' });
  });

  it('normalizes ./ prefixes and backslashes', () => {
    expect(parseSpecAnchor('.\\src\\auth\\session.ts#createSession'))
      .toEqual({ file: 'src/auth/session.ts', symbol: 'createSession' });
  });

  it('rejects anchors that escape the repository', () => {
    expect(parseSpecAnchor('../../etc/passwd')).toBeNull();
    expect(parseSpecAnchor('/etc/passwd#root')).toBeNull();
    expect(parseSpecAnchor('C:/Windows/system32.dll')).toBeNull();
  });

  it('keeps a dotted token as BOTH readings until the graph settles it', () => {
    // `Class.method` is shaped exactly like `utils.py`. A known code extension is
    // a file; anything else carries the member reading for the resolver to test.
    expect(parseSpecAnchor('SessionStore.create'))
      .toEqual({ file: 'SessionStore.create', symbol: null, memberCandidate: 'SessionStore.create' });
    expect(parseSpecAnchor('src/auth/session.py')).toEqual({ file: 'src/auth/session.py', symbol: null });
    expect(parseSpecAnchor('session.py')).toEqual({ file: 'session.py', symbol: null });
  });

  it('rejects prose that is neither a path nor an identifier', () => {
    expect(parseSpecAnchor('the session service')).toBeNull();
    expect(parseSpecAnchor('')).toBeNull();
  });
});

describe('normalizeAnchorPath', () => {
  it('collapses redundant segments inside the repo', () => {
    expect(normalizeAnchorPath('src/auth/../auth/session.ts')).toBe('src/auth/session.ts');
  });

  it('refuses to resolve outside the repo', () => {
    expect(normalizeAnchorPath('src/../../outside.ts')).toBeNull();
  });
});

// ============================================================================
// REQUIREMENT-SCOPED PARSING
// ============================================================================

describe('parseRequirementBlocks', () => {
  it('scopes anchors to the requirement that declares them', () => {
    const content = [
      '### Requirement: First',
      '- **Implementation**: `src/a.ts#alpha`',
      '',
      '### Requirement: Second',
      '- **Implementation**: `src/b.ts#beta`',
      '',
    ].join('\n');
    expect(parseRequirementBlocks(content)).toEqual([
      { name: 'First', line: 1, anchors: ['src/a.ts#alpha'] },
      { name: 'Second', line: 4, anchors: ['src/b.ts#beta'] },
    ]);
  });

  it('keeps scenario blocks inside their requirement but ignores their code spans', () => {
    const content = [
      '### Requirement: Scoped',
      '- **Implementation**: `src/a.ts#alpha`',
      '',
      '#### Scenario: Prose mentions code',
      '- **WHEN** `someOtherSymbol` is called',
      '- **THEN** it works',
    ].join('\n');
    expect(parseRequirementBlocks(content)[0].anchors).toEqual(['src/a.ts#alpha']);
  });

  it('reads comma-joined and continuation-line anchors', () => {
    const content = [
      '### Requirement: Multi',
      '- **Implementation**: `src/a.ts, src/b.ts`',
      '  `src/c.ts#gamma`',
      'prose ends the block',
      '  `src/d.ts`',
    ].join('\n');
    expect(parseRequirementBlocks(content)[0].anchors)
      .toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts#gamma']);
  });

  it('returns no anchors for a requirement that declares none', () => {
    expect(parseRequirementBlocks('### Requirement: Bare\n\nprose only\n')[0].anchors).toEqual([]);
  });

  it('survives malformed specs without throwing', () => {
    expect(parseRequirementBlocks('')).toEqual([]);
    expect(parseRequirementBlocks('### Requirement:\n')).toEqual([]);
    expect(parseRequirementBlocks('- **Implementation**: `src/a.ts`')).toEqual([]);
  });
});

// ============================================================================
// LINK RESOLUTION
// ============================================================================

describe('buildSpecLinkIndex', () => {
  it('links an exact unique anchor and records the covering symbol', () => {
    const index = build(
      specInput(spec('Sessions Expire', ['createSession::src/auth/session.ts'])),
      graph(node('src/auth/session.ts', [{ name: 'createSession', line: 12 }])),
    );
    expect(index.links).toHaveLength(1);
    expect(index.links[0]).toMatchObject({ state: 'linked', requirement: 'Sessions Expire' });
    expect(index.links[0].functions).toEqual([
      { name: 'createSession', file: 'src/auth/session.ts', line: 12, kind: 'function' },
    ]);
    expect(index.stats).toMatchObject({ linked: 1, ambiguous: 0, unmapped: 0, stale: 0, coveredFunctions: 1 });
  });

  it('does not invent function coverage from a file-only anchor', () => {
    const index = build(
      specInput(spec('Sessions Expire', ['src/auth/session.ts'])),
      graph(node('src/auth/session.ts', [{ name: 'createSession' }, { name: 'destroySession' }])),
    );
    expect(index.links[0].state).toBe('unmapped');
    expect(index.links[0].functions).toEqual([]);
    expect(index.links[0].footprintFiles).toEqual(['src/auth/session.ts']);
    expect(index.stats).toMatchObject({ unmapped: 1, coveredFunctions: 0, footprintFileCount: 1 });
    expect(index.stats.orphanCount).toBe(2);
  });

  it('links a dotted member anchor the graph holds', () => {
    const index = build(
      specInput(spec('Sessions Expire', ['SessionStore.create'])),
      graph(node('src/auth/session.ts', [{ name: 'SessionStore.create', line: 12 }])),
    );
    expect(index.links[0].state).toBe('linked');
    expect(index.links[0].functions).toEqual([
      { name: 'SessionStore.create', file: 'src/auth/session.ts', line: 12, kind: 'function' },
    ]);
    expect(index.stats).toMatchObject({ coveredFunctions: 1 });
  });

  it('leaves an unresolved dotted token as footprint rather than asserting a stale symbol', () => {
    // `config.yaml` is shaped like `Class.method`. With nothing of that name in the
    // graph, calling it a stale symbol would fabricate a citation the spec never made.
    const index = build(
      specInput(spec('Sessions Expire', ['config.yaml'])),
      graph(node('src/auth/session.ts', [{ name: 'createSession' }])),
    );
    expect(index.links[0].state).toBe('unmapped');
    expect(index.links[0].functions).toEqual([]);
    expect(index.links[0].footprintFiles).toEqual(['config.yaml']);
  });

  it('reports an anchor on an exported type as type-only, never as stale', () => {
    // `stale` asserts the cited symbol no longer exists. Saying that about a type
    // sitting right there is false: it is merely outside what coverage measures.
    const index = build(
      specInput(spec('Mounts A Widget', ['MountOptions::embed/src/mount.tsx'])),
      graph(node('embed/src/mount.tsx', [
        { name: 'mount', line: 40 },
        { name: 'MountOptions', line: 20, kind: 'interface', isType: true },
      ])),
    );
    const anchor = index.links[0].anchors[0];
    expect(anchor.state).toBe('type-only');
    // The type's location is disclosed, so a human can see what was cited.
    expect(anchor.candidates).toEqual([
      { name: 'MountOptions', file: 'embed/src/mount.tsx', line: 20, kind: 'interface' },
    ]);
    // No coverage is claimed, and no missing symbol is alleged.
    expect(index.links[0].state).toBe('unmapped');
    expect(index.links[0].functions).toEqual([]);
    expect(index.stats).toMatchObject({ stale: 0, unmapped: 1, coveredFunctions: 0 });
  });

  it('never lists an exported type as an uncovered orphan', () => {
    const index = build(
      specInput(spec('Mounts A Widget', ['mount::embed/src/mount.tsx'])),
      graph(node('embed/src/mount.tsx', [
        { name: 'mount', line: 40 },
        { name: 'MountHandle', line: 29, kind: 'interface', isType: true },
      ])),
    );
    expect(index.links[0].state).toBe('linked');
    expect(index.orphanFunctions).toEqual([]);
    expect(index.stats.totalExportedFunctions).toBe(1);
  });

  it('still reports a genuinely absent symbol as stale', () => {
    const index = build(
      specInput(spec('Mounts A Widget', ['vanished::embed/src/mount.tsx'])),
      graph(node('embed/src/mount.tsx', [{ name: 'mount', line: 40 }])),
    );
    expect(index.links[0].anchors[0].state).toBe('stale');
    expect(index.links[0].state).toBe('stale');
  });

  it('reports a duplicate symbol as ambiguous with bounded candidates, selecting none', () => {
    const index = build(
      specInput(spec('Sessions Expire', ['createSession'])),
      graph(
        node('src/auth/session.ts', [{ name: 'createSession', line: 12 }]),
        node('src/legacy/session.ts', [{ name: 'createSession', line: 40 }]),
      ),
    );
    expect(index.links[0].state).toBe('ambiguous');
    expect(index.links[0].functions).toEqual([]);
    expect(index.links[0].anchors[0].candidateTotal).toBe(2);
    expect(index.links[0].anchors[0].candidates.map(c => c.file))
      .toEqual(['src/auth/session.ts', 'src/legacy/session.ts']);
  });

  it('bounds disclosed candidates without hiding the true total', () => {
    const nodes = Array.from({ length: 9 }, (_, i) => node(`src/m${i}.ts`, [{ name: 'shared' }]));
    const index = buildSpecLinkIndex({
      specs: specInput(spec('Shared', ['shared'])),
      graph: graph(...nodes),
      analysisGeneration: 'gen-1',
      maxCandidates: 3,
    });
    expect(index.links[0].anchors[0].candidates).toHaveLength(3);
    expect(index.links[0].anchors[0].candidateTotal).toBe(9);
  });

  it('reports a deleted symbol as stale and discloses where the name still exists', () => {
    const index = build(
      specInput(spec('Sessions Expire', ['createSession::src/auth/session.ts'])),
      graph(node('src/auth/token.ts', [{ name: 'createSession', line: 5 }])),
    );
    expect(index.links[0].state).toBe('stale');
    expect(index.links[0].functions).toEqual([]);
    expect(index.links[0].anchors[0].candidates.map(c => c.file)).toEqual(['src/auth/token.ts']);
  });

  it('ranks a stale anchor above an ambiguous one in the same requirement', () => {
    const index = build(
      specInput(spec('Mixed', ['gone::src/a.ts', 'dup'])),
      graph(
        node('src/a.ts', [{ name: 'kept' }]),
        node('src/b.ts', [{ name: 'dup' }]),
        node('src/c.ts', [{ name: 'dup' }]),
      ),
    );
    expect(index.links[0].state).toBe('stale');
  });

  it('never resolves by name similarity', () => {
    const index = build(
      specInput(spec('Sessions Expire', ['createSession::src/auth/session.ts'])),
      graph(node('src/auth/session.ts', [{ name: 'createSessionToken' }, { name: 'create_session' }])),
    );
    expect(index.links[0].state).toBe('stale');
    expect(index.links[0].anchors[0].candidates).toEqual([]);
  });

  it('ignores type-only exports as coverage targets, without calling them missing', () => {
    // This case previously asserted `stale`, which was the wrong verdict: the type
    // is present in the graph, so claiming the spec cites something that no longer
    // exists was a false statement. It establishes no coverage — that part was
    // right — so the requirement is `unmapped`.
    const index = build(
      specInput(spec('Types', ['Session::src/auth/session.ts'])),
      graph(node('src/auth/session.ts', [{ name: 'Session', isType: true, kind: 'interface' }])),
    );
    expect(index.links[0].state).toBe('unmapped');
    expect(index.links[0].anchors[0].state).toBe('type-only');
    expect(index.stats.totalExportedFunctions).toBe(0);
  });

  it('orders links and orphans deterministically across runs', () => {
    const specs: SpecLinkIndexSpecInput[] = [
      { domain: 'z', specFile: 'openspec/specs/z/spec.md', content: spec('Bravo', ['b::src/b.ts']) },
      { domain: 'a', specFile: 'openspec/specs/a/spec.md', content: spec('Alpha', ['a::src/a.ts']) },
    ];
    const g = graph(node('src/b.ts', [{ name: 'b' }]), node('src/a.ts', [{ name: 'a' }]), node('src/c.ts', [{ name: 'c' }]));
    const first = build(specs, g);
    const second = build([...specs].reverse(), g);
    expect(first.links.map(l => l.specFile)).toEqual(['openspec/specs/a/spec.md', 'openspec/specs/z/spec.md']);
    expect(first).toEqual(second);
  });

  it('is a pure function of specs and graph', () => {
    const specs = specInput(spec('Sessions Expire', ['createSession::src/auth/session.ts']));
    const g = graph(node('src/auth/session.ts', [{ name: 'createSession' }]));
    expect(build(specs, g)).toEqual(build(specs, g));
  });
});

// ============================================================================
// PROVENANCE AND COMPATIBILITY
// ============================================================================

describe('specCorpusDigest', () => {
  it('is stable under input ordering', () => {
    const specs: SpecLinkIndexSpecInput[] = [
      { domain: 'a', specFile: 'a.md', content: 'one' },
      { domain: 'b', specFile: 'b.md', content: 'two' },
    ];
    expect(specCorpusDigest(specs)).toBe(specCorpusDigest([...specs].reverse()));
  });

  it('changes when any spec content changes', () => {
    const before = specCorpusDigest([{ domain: 'a', specFile: 'a.md', content: 'one' }]);
    const after = specCorpusDigest([{ domain: 'a', specFile: 'a.md', content: 'one!' }]);
    expect(after).not.toBe(before);
  });
});

describe('isLinkIndexCurrent', () => {
  const index = build(specInput(spec('R', [])), graph());

  it('accepts a matching generation and spec digest', () => {
    expect(isLinkIndexCurrent(index, 'gen-1', index.provenance.specDigest)).toBe(true);
  });

  it('rejects a spec edit even when the analysis is unchanged', () => {
    expect(isLinkIndexCurrent(index, 'gen-1', 'other-digest')).toBe(false);
  });

  it('rejects a new analysis generation even when the specs are unchanged', () => {
    expect(isLinkIndexCurrent(index, 'gen-2', index.provenance.specDigest)).toBe(false);
  });
});

describe('readMappingArtifact', () => {
  it('reads a current link index', () => {
    const index = build(specInput(spec('R', ['a::src/a.ts'])), graph(node('src/a.ts', [{ name: 'a' }])));
    const read = readMappingArtifact(JSON.stringify(index));
    expect(read.kind).toBe('link-index');
    expect(read.kind === 'link-index' && read.index.version).toBe(SPEC_LINK_INDEX_VERSION);
  });

  it('reports a v2 probabilistic artifact as legacy provenance, never converting it', () => {
    const legacy = JSON.stringify({
      version: 2, generatedAt: '2026-01-01T00:00:00.000Z',
      sourceAnalysisFingerprint: 'abc', mappings: [{ requirement: 'R', functions: [{ name: 'a' }] }],
    });
    expect(readMappingArtifact(legacy)).toEqual({
      kind: 'legacy', version: 2, generatedAt: '2026-01-01T00:00:00.000Z',
      sourceAnalysisFingerprint: 'abc', reason: 'incompatible-provenance',
    });
  });

  it('rejects a current-version artifact whose provenance is missing rather than trusting it', () => {
    expect(readMappingArtifact(JSON.stringify({ version: SPEC_LINK_INDEX_VERSION, links: [] })))
      .toEqual({ kind: 'invalid', reason: 'invalid-json' });
  });

  it('reports a superseded link-index version as legacy provenance, never as current', () => {
    const read = readMappingArtifact(JSON.stringify({ version: SPEC_LINK_INDEX_VERSION - 1, links: [] }));
    expect(read).toMatchObject({ kind: 'legacy', reason: 'incompatible-provenance' });
  });

  it('reports unparseable content as invalid-json', () => {
    expect(readMappingArtifact('{not json')).toEqual({ kind: 'invalid', reason: 'invalid-json' });
    expect(readMappingArtifact('[]')).toEqual({ kind: 'invalid', reason: 'invalid-json' });
  });
});

// ============================================================================
// LEGACY IMPLEMENTATION HINTS (pre-anchor generated specs)
// ============================================================================

describe('legacy `> Implementation:` hints', () => {
  const legacy = (symbol: string, file: string, confidence: string): string =>
    `# Spec\n\n### Requirement: Does A Thing\n\n> Implementation: \`${symbol}\` in \`${file}\` · confidence: ${confidence}\n\nThe system SHALL work.\n`;

  it('reads a reviewed hint as an exact symbol anchor', () => {
    const index = build(
      specInput(legacy('useAgent', 'ui/src/useAgent.ts', 'reviewed')),
      graph(node('ui/src/useAgent.ts', [{ name: 'useAgent', line: 3 }])),
    );
    expect(index.links[0].state).toBe('linked');
    expect(index.links[0].functions).toEqual([
      { name: 'useAgent', file: 'ui/src/useAgent.ts', line: 3, kind: 'function' },
    ]);
  });

  it('reads an llm-proposed hint as an exact anchor too — it was an explicit claim', () => {
    const index = build(
      specInput(legacy('useAgent', 'ui/src/useAgent.ts', 'llm')),
      graph(node('ui/src/useAgent.ts', [{ name: 'useAgent' }])),
    );
    expect(index.links[0].state).toBe('linked');
  });

  it('refuses a heuristic hint as coverage, keeping only its file as footprint', () => {
    const index = build(
      specInput(legacy('useAgent', 'ui/src/useAgent.ts', 'heuristic')),
      graph(node('ui/src/useAgent.ts', [{ name: 'useAgent' }])),
    );
    expect(index.links[0].state).toBe('unmapped');
    expect(index.links[0].functions).toEqual([]);
    expect(index.links[0].footprintFiles).toEqual(['ui/src/useAgent.ts']);
  });

  it('refuses a semantic hint as coverage for the same reason', () => {
    const index = build(
      specInput(legacy('useAgent', 'ui/src/useAgent.ts', 'semantic')),
      graph(node('ui/src/useAgent.ts', [{ name: 'useAgent' }])),
    );
    expect(index.links[0].state).toBe('unmapped');
  });

  it('splits a multi-symbol hint into one anchor per symbol', () => {
    const content = '# Spec\n\n### Requirement: Sends\n\n> Implementation: `send` / `prompt` in `ui/src/useAgent.ts` · confidence: reviewed\n';
    const index = build(
      specInput(content),
      graph(node('ui/src/useAgent.ts', [{ name: 'send' }, { name: 'prompt' }])),
    );
    expect(index.links[0].functions.map(fn => fn.name).sort()).toEqual(['prompt', 'send']);
  });

  it('reports a hint whose symbol is gone as stale, not as covered', () => {
    const index = build(
      specInput(legacy('reducer', 'ui/src/useAgent.ts', 'reviewed')),
      graph(node('ui/src/useAgent.ts', [{ name: 'useAgent' }])),
    );
    expect(index.links[0].state).toBe('stale');
    expect(index.links[0].functions).toEqual([]);
  });

  it('treats a hint with no confidence marker as an explicit claim', () => {
    const content = '# Spec\n\n### Requirement: Does A Thing\n\n> Implementation: `useAgent` in `ui/src/useAgent.ts`\n';
    const index = build(specInput(content), graph(node('ui/src/useAgent.ts', [{ name: 'useAgent' }])));
    expect(index.links[0].state).toBe('linked');
  });
});

describe('cache validity binds the schema version', () => {
  it('rejects a persisted index whose schema meaning predates this build', () => {
    const index = build(specInput(spec('R', ['a::src/a.ts'])), graph(node('src/a.ts', [{ name: 'a' }])));
    // Same analysis, same specs — only the interpretation changed. Without the
    // version in the validity check this stale cache would be served as current.
    const older = { ...index, version: (SPEC_LINK_INDEX_VERSION - 1) as typeof SPEC_LINK_INDEX_VERSION };
    expect(isLinkIndexCurrent(older, 'gen-1', index.provenance.specDigest)).toBe(false);
    expect(isLinkIndexCurrent(index, 'gen-1', index.provenance.specDigest)).toBe(true);
  });
});
