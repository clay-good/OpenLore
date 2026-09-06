import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  CORPUS_ARTIFACT_TYPES,
  CORPUS_EDGE_KINDS,
  CORPUS_EDGE_REGISTRY,
  CORPUS_FINDING_CODES,
  CORPUS_RESOURCE_LIMITS,
  detectCorpusIntegrity,
  evaluateCorpusGraph,
  supersessionCycleMembers,
  type CorpusArtifact,
  type CorpusEdge,
} from './corpus-integrity.js';

function artifact(
  key: string,
  type: CorpusArtifact['type'],
  identifier: string,
  extra: Partial<CorpusArtifact> = {},
): CorpusArtifact {
  return { key, type, identifier, path: `${key}.md`, live: true, ...extra };
}

function codes(artifacts: CorpusArtifact[], edges: CorpusEdge[]): string[] {
  return evaluateCorpusGraph({ artifacts, edges }).map((finding) => finding.code);
}

describe('CORPUS_EDGE_REGISTRY', () => {
  it('is closed over every supported edge and declares all graph semantics', () => {
    expect(Object.keys(CORPUS_EDGE_REGISTRY).sort()).toEqual([...CORPUS_EDGE_KINDS].sort());
    for (const spec of Object.values(CORPUS_EDGE_REGISTRY)) {
      expect(CORPUS_ARTIFACT_TYPES).toContain(spec.sourceArtifactType);
      expect(spec.targetRange.length).toBeGreaterThan(0);
      for (const target of spec.targetRange) expect(CORPUS_ARTIFACT_TYPES).toContain(target);
      expect(typeof spec.directional).toBe('boolean');
      expect(typeof spec.mayCycle).toBe('boolean');
      expect(typeof spec.liveSourceMayReferenceRetiredTarget).toBe('boolean');
    }
    expect(new Set(CORPUS_FINDING_CODES).size).toBe(CORPUS_FINDING_CODES.length);
  });
});

describe('evaluateCorpusGraph', () => {
  it('reports unresolved, wrong-type, self, unsupported, and missing-anchor references precisely', () => {
    const decision = artifact('decision-a', 'decision', 'aaaaaaaa');
    const requirement = artifact('requirement-a', 'requirement', 'RequireA');
    const memory = artifact('memory-a', 'memory', 'm1');
    const findings = evaluateCorpusGraph({
      artifacts: [decision, requirement, memory],
      edges: [
        { kind: 'spec-cites-decision', sourceKey: requirement.key, reference: 'deadbeef' },
        { kind: 'spec-cites-decision', sourceKey: requirement.key, reference: 'm1' },
        { kind: 'decision-supersedes', sourceKey: decision.key, reference: 'aaaaaaaa' },
        { kind: 'not-registered', sourceKey: requirement.key, reference: 'anything' },
        { kind: 'memory-anchors-symbol', sourceKey: memory.key, reference: 'gone::symbol', anchorMissing: true },
      ],
    });

    expect(findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'corpus-reference-unresolved',
      'corpus-target-type-mismatch',
      'corpus-self-reference',
      'corpus-edge-unsupported',
      'corpus-anchor-target-missing',
    ]));
    for (const finding of findings) {
      expect(finding.source).toBe('corpus-integrity');
      expect(finding.message).toContain(JSON.stringify(finding.discriminator!.split(':').slice(1).join(':')));
    }
  });

  it('reports duplicate identities and makes an inbound edge ambiguous', () => {
    const requirement = artifact('requirement', 'requirement', 'R');
    const first = artifact('decision-1', 'decision', 'aaaaaaaa');
    const second = artifact('decision-2', 'decision', 'aaaaaaaa');
    const findings = evaluateCorpusGraph({
      artifacts: [requirement, first, second],
      edges: [{ kind: 'spec-cites-decision', sourceKey: requirement.key, reference: 'aaaaaaaa' }],
    });
    expect(findings.filter((finding) => finding.code === 'corpus-duplicate-identifier')).toHaveLength(1);
    expect(findings.filter((finding) => finding.code === 'corpus-reference-ambiguous')).toHaveLength(1);
    expect(findings.every((finding) => finding.message.includes('aaaaaaaa'))).toBe(true);
  });

  it('reports a retired target with the terminal superseder and clears when re-pointed', () => {
    const old = artifact('old', 'decision', 'aaaaaaaa', { retiredBy: 'cccccccc' });
    const current = artifact('current', 'decision', 'cccccccc');
    const requirement = artifact('requirement', 'requirement', 'UseCurrent');
    const retired = evaluateCorpusGraph({
      artifacts: [old, current, requirement],
      edges: [{ kind: 'spec-cites-decision', sourceKey: requirement.key, reference: 'aaaaaaaa' }],
    });
    expect(retired).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'corpus-target-retired',
        message: expect.stringContaining('cite cccccccc instead'),
      }),
    ]));
    expect(codes(
      [old, current, requirement],
      [{ kind: 'spec-cites-decision', sourceKey: requirement.key, reference: 'cccccccc' }],
    )).not.toContain('corpus-target-retired');
  });

  it('reports every supersession-cycle member and exposes the same member set to claim verification', () => {
    const a = artifact('a', 'decision', 'aaaaaaaa');
    const b = artifact('b', 'decision', 'bbbbbbbb');
    const graph = {
      artifacts: [a, b],
      edges: [
        { kind: 'decision-supersedes', sourceKey: a.key, reference: 'bbbbbbbb' },
        { kind: 'decision-supersedes', sourceKey: b.key, reference: 'aaaaaaaa' },
      ],
    };
    expect(supersessionCycleMembers(graph)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    const cycle = evaluateCorpusGraph(graph).filter((finding) => finding.code === 'corpus-supersession-cycle');
    expect(cycle).toHaveLength(2);
    expect(cycle.map((finding) => finding.subject).sort()).toEqual([
      'decision:a.md#aaaaaaaa',
      'decision:b.md#bbbbbbbb',
    ]);
  });

  it('keeps disjoint supersession cycles separate in each finding', () => {
    const decisions = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd'].map((id) =>
      artifact(id, 'decision', id));
    const findings = evaluateCorpusGraph({
      artifacts: decisions,
      edges: [
        { kind: 'decision-supersedes', sourceKey: 'aaaaaaaa', reference: 'bbbbbbbb' },
        { kind: 'decision-supersedes', sourceKey: 'bbbbbbbb', reference: 'aaaaaaaa' },
        { kind: 'decision-supersedes', sourceKey: 'cccccccc', reference: 'dddddddd' },
        { kind: 'decision-supersedes', sourceKey: 'dddddddd', reference: 'cccccccc' },
      ],
    }).filter((finding) => finding.code === 'corpus-supersession-cycle');

    expect(findings.find((finding) => finding.subject.endsWith('#aaaaaaaa'))?.message)
      .not.toContain('cccccccc');
    expect(findings.find((finding) => finding.subject.endsWith('#cccccccc'))?.message)
      .not.toContain('aaaaaaaa');
  });

  it('validates requirement cycles while ignoring rejected decision cycles', () => {
    const first = artifact('first', 'requirement', 'First', { identityScope: 'x' });
    const second = artifact('second', 'requirement', 'Second', { identityScope: 'x' });
    const rejected = artifact('rejected', 'decision', 'aaaaaaaa', { live: false });
    const phantom = artifact('phantom', 'decision', 'bbbbbbbb', { live: false });
    const findings = evaluateCorpusGraph({
      artifacts: [first, second, rejected, phantom],
      edges: [
        { kind: 'spec-cites-requirement', sourceKey: first.key, reference: 'Second' },
        { kind: 'spec-cites-requirement', sourceKey: second.key, reference: 'First' },
        { kind: 'decision-supersedes', sourceKey: rejected.key, reference: 'bbbbbbbb' },
        { kind: 'decision-supersedes', sourceKey: phantom.key, reference: 'aaaaaaaa' },
      ],
    }).filter((finding) => finding.code === 'corpus-supersession-cycle');

    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.discriminator?.startsWith('spec-cites-requirement:'))).toBe(true);
  });

  it('walks a long acyclic chain within the focused-test timeout', () => {
    const count = 20_000;
    const artifacts = Array.from({ length: count }, (_, index) =>
      artifact(`r${index}`, 'requirement', `R${index}`, { identityScope: 'scale' }));
    const edges = artifacts.slice(0, -1).map((source, index) => ({
      kind: 'spec-cites-requirement', sourceKey: source.key, reference: `R${index + 1}`,
    }));
    expect(evaluateCorpusGraph({ artifacts, edges }).filter((finding) =>
      finding.code === 'corpus-supersession-cycle')).toEqual([]);
  }, 3_000);

  it('fails closed before evaluating a graph beyond its artifact ceiling', () => {
    const artifacts = Array.from({ length: CORPUS_RESOURCE_LIMITS.artifacts + 1 }, (_, index) =>
      artifact(`a${index}`, 'file', `f${index}`));
    expect(() => evaluateCorpusGraph({ artifacts, edges: [] })).toThrow('corpus artifact limit exceeded');
  });

  it('suggests exact undeclared references once and excludes fences, self, and declared lines', () => {
    const decision = artifact('decision', 'decision', 'aaaaaaaa');
    const declared = artifact('declared', 'requirement', 'Declared', {
      text: '### Requirement: Declared\n> Decision recorded: aaaaaaaa\nThe basis is aaaaaaaa.',
    });
    const prose = artifact('prose', 'requirement', 'Prose', {
      text: '### Requirement: Prose\nDecision aaaaaaaa applies. Again: aaaaaaaa.',
    });
    const fenced = artifact('fenced', 'requirement', 'Fenced', {
      text: '### Requirement: Fenced\n```text\naaaaaaaa\n```',
    });
    const self = artifact('self', 'requirement', 'SelfName', {
      identityScope: 'x',
      text: '### Requirement: SelfName\nSelfName remains itself.',
    });
    const findings = evaluateCorpusGraph({
      artifacts: [decision, declared, prose, fenced, self],
      edges: [{ kind: 'spec-cites-decision', sourceKey: declared.key, reference: 'aaaaaaaa' }],
    }).filter((finding) => finding.code === 'corpus-reference-undeclared');

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      subject: 'requirement:prose.md#Prose',
      discriminator: 'spec-cites-decision:aaaaaaaa',
      severity: 'warning',
    });
  });

  it('is byte-deterministic regardless of artifact and edge input order', () => {
    const req = artifact('req', 'requirement', 'R');
    const decision = artifact('decision', 'decision', 'aaaaaaaa');
    const edge = { kind: 'spec-cites-decision', sourceKey: req.key, reference: 'deadbeef' };
    const first = evaluateCorpusGraph({ artifacts: [req, decision], edges: [edge] });
    const second = evaluateCorpusGraph({ artifacts: [decision, req], edges: [edge] });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('detectCorpusIntegrity', () => {
  const storedDecision = (id: string, supersedes?: string, status = 'approved') => ({
    id, status, title: id, rationale: '', consequences: '', proposedRequirement: null,
    affectedDomains: [], affectedFiles: [], supersedes, syncedToSpecs: [],
  });

  it('reports an on-disk self-supersession edge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-self-'));
    await mkdir(join(root, '.openlore', 'decisions'), { recursive: true });
    await writeFile(join(root, '.openlore', 'decisions', 'pending.json'), JSON.stringify({
      decisions: [storedDecision('aaaaaaaa', 'aaaaaaaa')],
    }));
    expect(await detectCorpusIntegrity(root)).toContainEqual(expect.objectContaining({
      code: 'corpus-self-reference', discriminator: 'decision-supersedes:aaaaaaaa',
    }));
  });

  it('does not hide an unproven pending/durable id collision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-pending-durable-'));
    await mkdir(join(root, '.openlore', 'decisions'), { recursive: true });
    await mkdir(join(root, 'openspec', 'specs', 'demo'), { recursive: true });
    await writeFile(join(root, '.openlore', 'decisions', 'pending.json'), JSON.stringify({
      decisions: [storedDecision('aaaaaaaa', undefined, 'draft')],
    }));
    await writeFile(join(root, 'openspec', 'specs', 'demo', 'spec.md'),
      '# Demo\n\n## Decisions\n\n### Durable\n\n**Status:** Approved\n**ID:** aaaaaaaa\n');
    expect(await detectCorpusIntegrity(root)).toContainEqual(expect.objectContaining({
      code: 'corpus-duplicate-identifier', discriminator: 'identity:aaaaaaaa',
    }));
  });

  it('keeps an orphaned memory non-authoritative while reporting its missing anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-orphan-memory-'));
    await mkdir(join(root, '.openlore', 'decisions'), { recursive: true });
    await mkdir(join(root, '.openlore', 'memory'), { recursive: true });
    await writeFile(join(root, '.openlore', 'decisions', 'pending.json'), JSON.stringify({
      decisions: [storedDecision('aaaaaaaa'), storedDecision('bbbbbbbb', 'aaaaaaaa')],
    }));
    await writeFile(join(root, '.openlore', 'memory', 'notes.json'), JSON.stringify({ memories: [{
      id: 'm1', kind: 'note', content: 'aaaaaaaa', anchors: [{ filePath: 'missing.ts' }],
    }] }));
    const findings = await detectCorpusIntegrity(root);
    expect(findings).toContainEqual(expect.objectContaining({ code: 'corpus-anchor-target-missing' }));
    expect(findings).not.toContainEqual(expect.objectContaining({
      code: 'corpus-target-retired', subject: expect.stringContaining('memory:'),
    }));
  });

  it('reports root-relative paths with a nested custom OpenSpec directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-nested-path-'));
    const dir = join(root, 'docs', 'governance', 'openspec', 'specs', 'demo');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'spec.md'),
      '# Demo\n\n## Requirements\n\n### Requirement: Broken\n\n> Decision recorded: deadbeef\n');
    expect(await detectCorpusIntegrity(root, { openspecPath: 'docs/governance/openspec' }))
      .toContainEqual(expect.objectContaining({
        code: 'corpus-reference-unresolved',
        subject: 'requirement:docs/governance/openspec/specs/demo/spec.md#Broken',
      }));
  });

  it('reads the on-disk corpus without modifying it and reports an orphaned delta', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-'));
    await mkdir(join(root, 'openspec', 'specs', 'known'), { recursive: true });
    await mkdir(join(root, 'openspec', 'changes', 'active', 'specs', 'missing'), { recursive: true });
    await mkdir(join(root, '.openlore', 'decisions'), { recursive: true });
    await mkdir(join(root, '.openlore', 'memory'), { recursive: true });
    await writeFile(join(root, 'openspec', 'specs', 'known', 'spec.md'), '# Known\n\n## Requirements\n');
    await writeFile(join(root, 'openspec', 'changes', 'active', 'proposal.md'), '# Proposal\n');
    await writeFile(join(root, '.openlore', 'decisions', 'pending.json'), '{"decisions":[]}\n');
    await writeFile(join(root, '.openlore', 'memory', 'notes.json'), '{"memories":[]}\n');
    const before = await Promise.all([
      readFile(join(root, 'openspec', 'changes', 'active', 'proposal.md'), 'utf8'),
      readFile(join(root, '.openlore', 'decisions', 'pending.json'), 'utf8'),
    ]);

    const first = await detectCorpusIntegrity(root);
    const second = await detectCorpusIntegrity(root);

    expect(first).toEqual(second);
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'corpus-reference-unresolved',
        discriminator: 'change-delta-targets-domain:missing',
      }),
    ]));
    expect(await Promise.all([
      readFile(join(root, 'openspec', 'changes', 'active', 'proposal.md'), 'utf8'),
      readFile(join(root, '.openlore', 'decisions', 'pending.json'), 'utf8'),
    ])).toEqual(before);
  });

  it('accepts a delta that targets a proposal-declared new capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-new-domain-'));
    await mkdir(join(root, 'openspec', 'changes', 'active', 'specs', 'new-domain'), { recursive: true });
    await writeFile(join(root, 'openspec', 'changes', 'active', 'proposal.md'), [
      '# Proposal',
      '',
      '## Capabilities',
      '',
      '### New Capabilities',
      '',
      '- `new-domain`: A new domain.',
      '',
      '### Modified Capabilities',
      '',
    ].join('\n'));

    const findings = await detectCorpusIntegrity(root);

    expect(findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'corpus-reference-unresolved',
        discriminator: 'change-delta-targets-domain:new-domain',
      }),
    ]));
  });

  it('lets a proposal clear an exact-reference advisory with a declared corpus edge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-proposal-edge-'));
    await mkdir(join(root, 'openspec', 'specs', 'known'), { recursive: true });
    await mkdir(join(root, 'openspec', 'changes', 'active'), { recursive: true });
    await writeFile(join(root, 'openspec', 'specs', 'known', 'spec.md'), [
      '# Known',
      '',
      '## Decisions',
      '',
      '**ID:** aaaaaaaa',
      '',
    ].join('\n'));
    await writeFile(join(root, 'openspec', 'changes', 'active', 'proposal.md'), [
      '# Proposal',
      '',
      '> Corpus edge: proposal-cites-decision aaaaaaaa',
      '',
      'Decision aaaaaaaa governs this change.',
      '',
    ].join('\n'));

    const findings = await detectCorpusIntegrity(root);

    expect(findings.filter((finding) => finding.discriminator?.endsWith(':aaaaaaaa'))).toEqual([]);
  });

  it('confines a configured OpenSpec path to the repository root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-confined-'));
    const outside = await mkdtemp(join(tmpdir(), 'openlore-corpus-outside-'));
    await mkdir(join(outside, 'specs', 'x'), { recursive: true });
    await writeFile(join(outside, 'specs', 'x', 'spec.md'), '# Outside\n');

    await expect(detectCorpusIntegrity(root, { openspecPath: outside })).rejects.toThrow(/outside project directory/);
  });  // skipIf(win32): creating a symlink there needs elevated privileges or Developer Mode,
  // so this cannot build the premise it asserts about and would test a plain file instead.
  // What it guards is platform-independent and is exercised on Linux.


  it.skipIf(process.platform === 'win32')('rejects symlink escapes from stores, specs, proposals, delta directories, and anchors', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'openlore-corpus-outside-files-'));
    await writeFile(join(outside, 'pending.json'), '{"decisions":[]}');
    await writeFile(join(outside, 'spec.md'), '# Outside\n');
    await writeFile(join(outside, 'proposal.md'), '# Outside proposal\n');
    await mkdir(join(outside, 'specs'));
    await writeFile(join(outside, 'anchor.ts'), 'export {};\n');

    const storeRoot = await mkdtemp(join(tmpdir(), 'openlore-corpus-store-link-'));
    await mkdir(join(storeRoot, '.openlore', 'decisions'), { recursive: true });
    await symlink(join(outside, 'pending.json'), join(storeRoot, '.openlore', 'decisions', 'pending.json'));
    await expect(detectCorpusIntegrity(storeRoot)).rejects.toThrow(/Path escape blocked/);

    const specRoot = await mkdtemp(join(tmpdir(), 'openlore-corpus-spec-link-'));
    await mkdir(join(specRoot, 'openspec', 'specs', 'domain'), { recursive: true });
    await symlink(join(outside, 'spec.md'), join(specRoot, 'openspec', 'specs', 'domain', 'spec.md'));
    await expect(detectCorpusIntegrity(specRoot)).rejects.toThrow(/Path escape blocked/);

    const domainRoot = await mkdtemp(join(tmpdir(), 'openlore-corpus-domain-link-'));
    await mkdir(join(domainRoot, 'openspec', 'specs'), { recursive: true });
    await symlink(outside, join(domainRoot, 'openspec', 'specs', 'escaped'));
    await expect(detectCorpusIntegrity(domainRoot)).rejects.toThrow(/symbolic-link directory entry/);

    const proposalRoot = await mkdtemp(join(tmpdir(), 'openlore-corpus-proposal-link-'));
    await mkdir(join(proposalRoot, 'openspec', 'changes', 'active'), { recursive: true });
    await symlink(join(outside, 'proposal.md'), join(proposalRoot, 'openspec', 'changes', 'active', 'proposal.md'));
    await expect(detectCorpusIntegrity(proposalRoot)).rejects.toThrow(/Path escape blocked/);

    const deltaRoot = await mkdtemp(join(tmpdir(), 'openlore-corpus-delta-link-'));
    await mkdir(join(deltaRoot, 'openspec', 'changes', 'active'), { recursive: true });
    await symlink(join(outside, 'specs'), join(deltaRoot, 'openspec', 'changes', 'active', 'specs'));
    await expect(detectCorpusIntegrity(deltaRoot)).rejects.toThrow(/Path escape blocked/);

    const anchorRoot = await mkdtemp(join(tmpdir(), 'openlore-corpus-anchor-link-'));
    await mkdir(join(anchorRoot, '.openlore', 'memory'), { recursive: true });
    await symlink(join(outside, 'anchor.ts'), join(anchorRoot, 'anchor.ts'));
    await writeFile(join(anchorRoot, '.openlore', 'memory', 'notes.json'), JSON.stringify({
      memories: [{ id: 'aaaaaaaa', kind: 'note', content: 'anchored', anchors: [{ filePath: 'anchor.ts' }], recordedAt: '' }],
    }));
    await expect(detectCorpusIntegrity(anchorRoot)).rejects.toThrow(/Path escape blocked/);
  });

  it.each([
    ['invalid JSON', '{not-json'],
    ['non-object root', '[]'],
    ['missing property', '{}'],
    ['non-array property', '{"decisions":{}}'],
    ['malformed entry', '{"decisions":[null]}'],
    ['malformed entry fields', '{"decisions":[{"id":7}]}'],
  ])('does not misreport a malformed decision store as empty: %s', async (_label, contents) => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-malformed-decision-'));
    await mkdir(join(root, '.openlore', 'decisions'), { recursive: true });
    await writeFile(join(root, '.openlore', 'decisions', 'pending.json'), contents);

    await expect(detectCorpusIntegrity(root)).rejects.toThrow();
  });

  it.each([
    ['non-object root', 'null'],
    ['missing property', '{}'],
    ['non-array property', '{"memories":"none"}'],
    ['malformed entry', '{"memories":[null]}'],
    ['malformed anchor', '{"memories":[{"id":"aaaaaaaa","kind":"note","content":"x","anchors":[null]}]}'],
  ])('does not misreport a malformed memory store as empty: %s', async (_label, contents) => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-malformed-memory-'));
    await mkdir(join(root, '.openlore', 'memory'), { recursive: true });
    await writeFile(join(root, '.openlore', 'memory', 'notes.json'), contents);

    await expect(detectCorpusIntegrity(root)).rejects.toThrow();
  });

  it('reconstructs ADR-only supersession and ignores a rejected superseder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-adr-'));
    await mkdir(join(root, 'openspec', 'specs', 'known'), { recursive: true });
    await mkdir(join(root, 'openspec', 'decisions'), { recursive: true });
    await writeFile(join(root, 'openspec', 'specs', 'known', 'spec.md'), [
      '# Known', '', '## Requirements', '',
      '### Requirement: CiteOldDecision', '',
      'The system SHALL cite the original decision.', '',
      '> Corpus edge: spec-cites-decision aaaaaaaa', '',
    ].join('\n'));
    await writeFile(join(root, 'openspec', 'decisions', 'adr-0001-old.md'), [
      '# ADR-0001: Old', '', '## Status', '', 'accepted', '',
      '> Decision ID: aaaaaaaa', '',
    ].join('\n'));
    const replacementPath = join(root, 'openspec', 'decisions', 'adr-0002-new.md');
    await writeFile(replacementPath, [
      '# ADR-0002: New', '', '## Status', '', 'accepted', '',
      '> Decision ID: bbbbbbbb',
      '> Supersedes: aaaaaaaa', '',
    ].join('\n'));

    expect(await detectCorpusIntegrity(root)).toContainEqual(expect.objectContaining({
      code: 'corpus-target-retired',
      message: expect.stringContaining('cite bbbbbbbb instead'),
    }));

    await writeFile(replacementPath, [
      '# ADR-0002: New', '', '## Status', '', 'rejected', '',
      '> Decision ID: bbbbbbbb',
      '> Supersedes: aaaaaaaa', '',
    ].join('\n'));
    expect((await detectCorpusIntegrity(root)).filter((finding) =>
      finding.code === 'corpus-target-retired' || finding.code === 'corpus-supersession-cycle',
    )).toEqual([]);
  });

  it('discovers delta requirements and stops requirement prose at later headings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-delta-requirements-'));
    await mkdir(join(root, 'openspec', 'specs', 'known'), { recursive: true });
    await mkdir(join(root, 'openspec', 'changes', 'active', 'specs', 'known'), { recursive: true });
    await writeFile(join(root, 'openspec', 'specs', 'known', 'spec.md'), [
      '# Known', '## Requirements', '### Requirement: First', 'The system SHALL work.',
      '### Requirement: Second', 'The system SHALL also work.', '## Decisions', 'First', '',
    ].join('\n'));
    await writeFile(join(root, 'openspec', 'changes', 'active', 'specs', 'known', 'spec.md'), [
      '# Delta', '## ADDED Requirements', '### Requirement: DeltaRequirement',
      '> Decision recorded: deadbeef', 'The system SHALL cite its decision.', '',
    ].join('\n'));

    const findings = await detectCorpusIntegrity(root);
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'corpus-reference-unresolved',
      subject: expect.stringContaining('#DeltaRequirement'),
      discriminator: 'spec-cites-decision:deadbeef',
    }));
    expect(findings).not.toContainEqual(expect.objectContaining({
      code: 'corpus-reference-undeclared',
      subject: expect.stringContaining('#Second'),
      discriminator: 'spec-cites-requirement:First',
    }));
  });

  it('preserves duplicate durable decisions and competing prospective domains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-duplicates-'));
    await mkdir(join(root, 'openspec', 'specs', 'one'), { recursive: true });
    await writeFile(join(root, 'openspec', 'specs', 'one', 'spec.md'),
      '# one\n\n### First decision\n\n**ID:** aaaaaaaa\n\n### Duplicate decision\n\n**ID:** aaaaaaaa\n');
    for (const change of ['first', 'second']) {
      await mkdir(join(root, 'openspec', 'changes', change, 'specs', 'future'), { recursive: true });
      await writeFile(join(root, 'openspec', 'changes', change, 'proposal.md'), [
        '# Proposal', '### New Capabilities', '- `future`: Future capability.', '',
      ].join('\n'));
    }

    const findings = await detectCorpusIntegrity(root);
    expect(findings.filter((finding) =>
      finding.code === 'corpus-duplicate-identifier' && finding.discriminator === 'identity:aaaaaaaa')).toHaveLength(1);
    expect(findings.filter((finding) =>
      finding.code === 'corpus-duplicate-identifier' && finding.discriminator === 'identity:future')).toHaveLength(1);
    expect(findings.filter((finding) =>
      finding.code === 'corpus-reference-ambiguous'
      && finding.discriminator === 'change-delta-targets-domain:future')).toHaveLength(2);
  });

  it('coalesces one synced decision projected byte-identically into multiple domains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-decision-projections-'));
    const entry = [
      '### Shared decision',
      '',
      '**Status:** Approved',
      '**Date:** 2026-08-23',
      '**ID:** aaaaaaaa',
      '',
      'One decision governs both domains.',
      '',
      '**Consequences:** Both specs carry the same durable projection.',
      '',
    ].join('\n');
    for (const domain of ['one', 'two']) {
      await mkdir(join(root, 'openspec', 'specs', domain), { recursive: true });
      await writeFile(join(root, 'openspec', 'specs', domain, 'spec.md'), `# ${domain}\n\n## Decisions\n\n${entry}`);
    }

    const findings = await detectCorpusIntegrity(root);
    expect(findings).not.toContainEqual(expect.objectContaining({
      code: 'corpus-duplicate-identifier',
      discriminator: 'identity:aaaaaaaa',
    }));
  });

  it('fails closed when one corpus document exceeds its byte ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-oversize-'));
    await mkdir(join(root, 'openspec', 'changes', 'active'), { recursive: true });
    await writeFile(join(root, 'openspec', 'changes', 'active', 'proposal.md'),
      'x'.repeat(CORPUS_RESOURCE_LIMITS.fileBytes + 1));
    await expect(detectCorpusIntegrity(root)).rejects.toThrow('exceeds byte limit');
  });
});
