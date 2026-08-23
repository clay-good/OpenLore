/**
 * Deterministic integrity checking for OpenLore's on-disk governance corpus.
 * (change: add-knowledge-corpus-integrity)
 *
 * The evaluator is deliberately split from discovery. `evaluateCorpusGraph` is a
 * pure typed-graph pass (and is useful to callers that already have the corpus in
 * memory); `detectCorpusIntegrity` only reads the stores and OpenSpec tree before
 * invoking it. Neither path writes, calls a model, or uses the network.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { AnchoredMemory, PendingDecision, StructuralAnchor } from '../../types/index.js';
import type { GovernanceFinding } from '../services/mcp-handlers/enforcement-policy.js';
import {
  buildRetirementGraph,
  staleRefsInText,
} from '../services/mcp-handlers/stale-decision-reference.js';
import { readFileConfined, safeJoin } from '../../utils/path-confinement.js';

export const CORPUS_ARTIFACT_TYPES = [
  'requirement',
  'decision',
  'spec-domain',
  'change-delta',
  'memory',
  'symbol',
  'file',
  'proposal',
] as const;

export type CorpusArtifactType = (typeof CORPUS_ARTIFACT_TYPES)[number];

export const CORPUS_EDGE_KINDS = [
  'spec-cites-decision',
  'spec-cites-requirement',
  'proposal-cites-decision',
  'proposal-cites-requirement',
  'decision-supersedes',
  'change-delta-targets-domain',
  'memory-cites-decision',
  'memory-anchors-symbol',
  'spec-anchors-symbol',
] as const;

export type CorpusEdgeKind = (typeof CORPUS_EDGE_KINDS)[number];

/** Edge kinds emitted by each independent on-disk discovery path. */
export const CORPUS_DISCOVERY_EDGE_KINDS = {
  requirementLines: ['spec-cites-decision', 'spec-cites-requirement', 'spec-anchors-symbol'],
  proposalLines: ['proposal-cites-decision', 'proposal-cites-requirement'],
  decisionRecords: ['decision-supersedes'],
  changeDeltas: ['change-delta-targets-domain'],
  memoryRecords: ['memory-cites-decision', 'memory-anchors-symbol'],
} as const satisfies Record<string, readonly CorpusEdgeKind[]>;

export interface CorpusEdgeSpec {
  sourceArtifactType: CorpusArtifactType;
  targetRange: readonly CorpusArtifactType[];
  directional: boolean;
  mayCycle: boolean;
  liveSourceMayReferenceRetiredTarget: boolean;
}

/** The closed, source-declared contract for every supported corpus edge. */
export const CORPUS_EDGE_REGISTRY: Record<CorpusEdgeKind, CorpusEdgeSpec> = {
  'spec-cites-decision': {
    sourceArtifactType: 'requirement',
    targetRange: ['decision'],
    directional: true,
    mayCycle: false,
    liveSourceMayReferenceRetiredTarget: false,
  },
  'spec-cites-requirement': {
    sourceArtifactType: 'requirement',
    targetRange: ['requirement'],
    directional: true,
    mayCycle: false,
    liveSourceMayReferenceRetiredTarget: false,
  },
  'proposal-cites-decision': {
    sourceArtifactType: 'proposal',
    targetRange: ['decision'],
    directional: true,
    mayCycle: false,
    liveSourceMayReferenceRetiredTarget: false,
  },
  'proposal-cites-requirement': {
    sourceArtifactType: 'proposal',
    targetRange: ['requirement'],
    directional: true,
    mayCycle: false,
    liveSourceMayReferenceRetiredTarget: false,
  },
  'decision-supersedes': {
    sourceArtifactType: 'decision',
    targetRange: ['decision'],
    directional: true,
    mayCycle: false,
    liveSourceMayReferenceRetiredTarget: true,
  },
  'change-delta-targets-domain': {
    sourceArtifactType: 'change-delta',
    targetRange: ['spec-domain'],
    directional: true,
    mayCycle: false,
    liveSourceMayReferenceRetiredTarget: true,
  },
  'memory-cites-decision': {
    sourceArtifactType: 'memory',
    targetRange: ['decision'],
    directional: true,
    mayCycle: false,
    liveSourceMayReferenceRetiredTarget: false,
  },
  'memory-anchors-symbol': {
    sourceArtifactType: 'memory',
    targetRange: ['symbol', 'file'],
    directional: true,
    mayCycle: false,
    liveSourceMayReferenceRetiredTarget: true,
  },
  'spec-anchors-symbol': {
    sourceArtifactType: 'requirement',
    targetRange: ['symbol', 'file'],
    directional: true,
    mayCycle: false,
    liveSourceMayReferenceRetiredTarget: true,
  },
};

export const CORPUS_FINDING_CODES = [
  'corpus-reference-unresolved',
  'corpus-reference-ambiguous',
  'corpus-self-reference',
  'corpus-duplicate-identifier',
  'corpus-edge-unsupported',
  'corpus-target-type-mismatch',
  'corpus-target-retired',
  'corpus-supersession-cycle',
  'corpus-anchor-target-missing',
  'corpus-reference-undeclared',
] as const;

export type CorpusFindingCode = (typeof CORPUS_FINDING_CODES)[number];

export const CORPUS_RESOURCE_LIMITS = {
  fileBytes: 4 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  directoryEntries: 20_000,
  artifacts: 100_000,
  edges: 250_000,
  findings: 100_000,
  mentionPairs: 25_000_000,
} as const;

export interface CorpusArtifact {
  /** Unique internal key; unlike `identifier`, this never participates in resolution. */
  key: string;
  type: CorpusArtifactType;
  /** The exact externally referenced identifier (decision id, requirement name, domain, and so on). */
  identifier: string;
  path: string;
  /** Requirement identities are scoped to their spec domain. Other identities are global. */
  identityScope?: string;
  text?: string;
  live?: boolean;
  retiredBy?: string;
}

export interface CorpusEdge {
  /** Kept open at the input boundary so an undeclared kind produces a finding, not a cast failure. */
  kind: string;
  sourceKey: string;
  /** The reference exactly as written in the source artifact. */
  reference: string;
  /** For structured anchors, discovery can prove absence without inventing a target artifact. */
  anchorMissing?: boolean;
  /** Discovery-only hint retained from an explicit Symbol/File anchor line. */
  anchorTargetType?: 'symbol' | 'file';
}

export interface CorpusGraph {
  artifacts: readonly CorpusArtifact[];
  edges: readonly CorpusEdge[];
}

const DECISION_ID_GLOBAL = /\b[0-9a-f]{8}\b/g;

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finding(
  code: CorpusFindingCode,
  source: CorpusArtifact | undefined,
  edgeKind: string,
  reference: string,
  reason: string,
): GovernanceFinding {
  const subject = source ? `${source.type}:${source.path}#${source.identifier}` : 'corpus:unknown';
  return {
    code,
    severity: code === 'corpus-target-retired' || code === 'corpus-anchor-target-missing' || code === 'corpus-reference-undeclared'
      ? 'warning'
      : 'error',
    source: 'corpus-integrity',
    subject,
    discriminator: `${edgeKind}:${reference}`,
    message: `${subject} has ${edgeKind} reference ${JSON.stringify(reference)}: ${reason}`,
  };
}

function identityKey(artifact: CorpusArtifact): string {
  return `${artifact.type}\0${artifact.identityScope ?? ''}\0${artifact.identifier}`;
}

function findingKey(value: GovernanceFinding): string {
  return [value.code, value.subject, value.discriminator ?? '', value.message].join('\0');
}

interface CorpusCycle {
  kind: CorpusEdgeKind;
  memberKeys: string[];
  identifiers: string[];
}

/** Validate every registry edge declared acyclic whose range can connect back to its source type. */
function acyclicEdgeCycles(graph: CorpusGraph): CorpusCycle[] {
  const liveArtifacts = new Map(graph.artifacts
    .filter((artifact) => artifact.live ?? true)
    .map((artifact) => [artifact.key, artifact]));
  const byIdentifier = new Map<string, CorpusArtifact[]>();
  for (const artifact of liveArtifacts.values()) {
    const matches = byIdentifier.get(artifact.identifier) ?? [];
    matches.push(artifact);
    byIdentifier.set(artifact.identifier, matches);
  }

  const cycles = new Map<string, CorpusCycle>();
  for (const kind of CORPUS_EDGE_KINDS) {
    const spec = CORPUS_EDGE_REGISTRY[kind];
    if (spec.mayCycle || !spec.targetRange.includes(spec.sourceArtifactType)) continue;
    const sources = new Map([...liveArtifacts]
      .filter(([, artifact]) => artifact.type === spec.sourceArtifactType));
    const next = new Map<string, string>();
    for (const edge of graph.edges) {
      if (edge.kind !== kind || !sources.has(edge.sourceKey)) continue;
      const matches = (byIdentifier.get(edge.reference) ?? [])
        .filter((artifact) => spec.targetRange.includes(artifact.type));
      if (matches.length === 1 && sources.has(matches[0].key)) next.set(edge.sourceKey, matches[0].key);
    }

    const completed = new Set<string>();
    for (const start of [...sources.keys()].sort(stableCompare)) {
      if (completed.has(start)) continue;
      const path: string[] = [];
      const at = new Map<string, number>();
      let current: string | undefined = start;
      while (current !== undefined && !completed.has(current) && !at.has(current)) {
        at.set(current, path.length);
        path.push(current);
        current = next.get(current);
      }
      if (current !== undefined && at.has(current)) {
        const memberKeys = path.slice(at.get(current)!).sort(stableCompare);
        const identifiers = memberKeys.map((key) => sources.get(key)!.identifier).sort(stableCompare);
        cycles.set(`${kind}\0${memberKeys.join('\0')}`, { kind, memberKeys, identifiers });
      }
      for (const member of path) completed.add(member);
    }
  }
  return [...cycles.values()].sort((a, b) =>
    stableCompare(`${a.kind}\0${a.memberKeys.join('\0')}`, `${b.kind}\0${b.memberKeys.join('\0')}`));
}

/** Return each live decision-supersession cycle independently, in canonical order. */
function supersessionCycles(graph: CorpusGraph): string[][] {
  return acyclicEdgeCycles(graph)
    .filter((cycle) => cycle.kind === 'decision-supersedes')
    .map((cycle) => cycle.identifiers);
}

/** Return every member of every decision-supersession cycle, in stable order. */
export function supersessionCycleMembers(graph: CorpusGraph): string[] {
  return supersessionCycles(graph).flat().sort(stableCompare);
}

function withoutFencedCodeAndReferenceLines(text: string): string {
  let fenced = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return '';
    }
    if (fenced) return '';
    if (/^>\s*(?:Decision recorded|Decision pointer|Decision citation|Symbol anchor|File anchor|Corpus edge)\s*:/i.test(line)) return '';
    return line;
  }).join('\n');
}

function exactMentions(text: string, identifiers: readonly string[]): Set<string> {
  const found = new Set<string>();
  // A bounded alternation avoids rescanning every source once per corpus target.
  // Longest-first keeps a shorter identifier from consuming a longer phrase.
  const ordered = [...new Set(identifiers.filter(Boolean))]
    .sort((a, b) => b.length - a.length || stableCompare(a, b));
  for (let offset = 0; offset < ordered.length; offset += 200) {
    const alternatives = ordered.slice(offset, offset + 200).map((token) => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const left = /^[A-Za-z0-9_]/.test(token) ? '(?<![A-Za-z0-9_])' : '';
      const right = /[A-Za-z0-9_]$/.test(token) ? '(?![A-Za-z0-9_])' : '';
      return `${left}${escaped}${right}`;
    });
    for (const match of text.matchAll(new RegExp(alternatives.join('|'), 'g'))) found.add(match[0]);
  }
  return found;
}

function suggestedEdge(source: CorpusArtifact, target: CorpusArtifact): string | undefined {
  if (target.type === 'decision') {
    if (source.type === 'memory') return 'memory-cites-decision';
    if (source.type === 'requirement') return 'spec-cites-decision';
    if (source.type === 'proposal') return 'proposal-cites-decision';
  }
  if (target.type === 'requirement') {
    if (source.type === 'requirement') return 'spec-cites-requirement';
    if (source.type === 'proposal') return 'proposal-cites-requirement';
  }
  return undefined;
}

/** Pure, deterministic validation over a fully discovered graph. */
export function evaluateCorpusGraph(graph: CorpusGraph): GovernanceFinding[] {
  if (graph.artifacts.length > CORPUS_RESOURCE_LIMITS.artifacts) {
    throw new Error(`corpus artifact limit exceeded (${CORPUS_RESOURCE_LIMITS.artifacts})`);
  }
  if (graph.edges.length > CORPUS_RESOURCE_LIMITS.edges) {
    throw new Error(`corpus edge limit exceeded (${CORPUS_RESOURCE_LIMITS.edges})`);
  }
  const findings: GovernanceFinding[] = [];
  const addFinding = (value: GovernanceFinding): void => {
    if (findings.length >= CORPUS_RESOURCE_LIMITS.findings) {
      throw new Error(`corpus finding limit exceeded (${CORPUS_RESOURCE_LIMITS.findings})`);
    }
    findings.push(value);
  };
  const artifactsByKey = new Map(graph.artifacts.map((artifact) => [artifact.key, artifact]));
  const identities = new Map<string, CorpusArtifact[]>();
  const artifactsByIdentifier = new Map<string, CorpusArtifact[]>();
  for (const artifact of graph.artifacts) {
    const matches = identities.get(identityKey(artifact)) ?? [];
    matches.push(artifact);
    identities.set(identityKey(artifact), matches);
    const identifierMatches = artifactsByIdentifier.get(artifact.identifier) ?? [];
    identifierMatches.push(artifact);
    artifactsByIdentifier.set(artifact.identifier, identifierMatches);
  }

  for (const duplicates of identities.values()) {
    if (duplicates.length < 2) continue;
    const sorted = [...duplicates].sort((a, b) => stableCompare(a.key, b.key));
    const source = sorted[0];
    addFinding(finding(
      'corpus-duplicate-identifier',
      source,
      'identity',
      source.identifier,
      `identifier resolves to multiple artifacts: ${sorted.map((item) => item.path).join(', ')}`,
    ));
  }

  const declaredTargets = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const source = artifactsByKey.get(edge.sourceKey);
    const spec = CORPUS_EDGE_REGISTRY[edge.kind as CorpusEdgeKind];
    if (!source || !spec || source.type !== spec.sourceArtifactType) {
      addFinding(finding(
        'corpus-edge-unsupported', source, edge.kind, edge.reference,
        !spec ? 'edge kind is not declared in CORPUS_EDGE_REGISTRY' : `source type ${source?.type ?? 'missing'} does not declare this edge`,
      ));
      continue;
    }

    const declared = declaredTargets.get(source.key) ?? new Set<string>();
    declared.add(edge.reference);
    declaredTargets.set(source.key, declared);

    if (edge.anchorMissing) {
      addFinding(finding(
        'corpus-anchor-target-missing', source, edge.kind, edge.reference,
        'the anchored symbol or file no longer exists',
      ));
      continue;
    }

    const identifierMatches = artifactsByIdentifier.get(edge.reference) ?? [];
    const allowed = identifierMatches.filter((artifact) =>
      spec.targetRange.includes(artifact.type) && artifact.identifier === edge.reference,
    );
    const anyType = identifierMatches;
    if (allowed.length === 0) {
      addFinding(finding(
        anyType.length > 0 ? 'corpus-target-type-mismatch' : 'corpus-reference-unresolved',
        source,
        edge.kind,
        edge.reference,
        anyType.length > 0
          ? `target resolves as ${[...new Set(anyType.map((item) => item.type))].sort().join(', ')}, not ${spec.targetRange.join(' or ')}`
          : `no ${spec.targetRange.join(' or ')} target resolves`,
      ));
      continue;
    }
    if (allowed.length > 1) {
      addFinding(finding(
        'corpus-reference-ambiguous', source, edge.kind, edge.reference,
        `target resolves to multiple artifacts: ${allowed.map((item) => item.path).sort(stableCompare).join(', ')}`,
      ));
      continue;
    }
    const target = allowed[0];
    if (target.key === source.key) {
      addFinding(finding('corpus-self-reference', source, edge.kind, edge.reference, 'an artifact may not reference itself'));
    }
    if ((source.live ?? true) && target.retiredBy && !spec.liveSourceMayReferenceRetiredTarget) {
      addFinding(finding(
        'corpus-target-retired', source, edge.kind, edge.reference,
        `target is retired${target.retiredBy !== target.identifier ? `; cite ${target.retiredBy} instead` : ''}`,
      ));
    }
  }

  for (const cycle of acyclicEdgeCycles(graph)) {
    for (const memberKey of cycle.memberKeys) {
      const source = artifactsByKey.get(memberKey);
      addFinding(finding(
        'corpus-supersession-cycle', source, cycle.kind, source?.identifier ?? memberKey,
        `acyclic ${cycle.kind} edge forms a cycle containing ${cycle.identifiers.join(', ')}; none of these artifacts is authoritative`,
      ));
    }
  }

  // Exact mentioned-but-unlinked suggestions. Only identifier/name targets are
  // considered; paths, titles, fuzzy matches, and self mentions are excluded.
  const mentionTargets = graph.artifacts.filter((artifact) => artifact.type === 'decision' || artifact.type === 'requirement');
  const mentionIdentifiers = mentionTargets.map((target) => target.identifier);
  const mentionSources = graph.artifacts.filter((source) =>
    source.text && (source.type === 'requirement' || source.type === 'proposal'));
  if (mentionSources.length * mentionTargets.length > CORPUS_RESOURCE_LIMITS.mentionPairs) {
    throw new Error(`corpus mention-work limit exceeded (${CORPUS_RESOURCE_LIMITS.mentionPairs} pairs)`);
  }
  for (const source of mentionSources) {
    if (!source.text || (source.type !== 'requirement' && source.type !== 'proposal')) continue;
    const prose = withoutFencedCodeAndReferenceLines(source.text);
    const mentioned = exactMentions(prose, mentionIdentifiers);
    const already = declaredTargets.get(source.key) ?? new Set<string>();
    const seenTargets = new Set<string>();
    for (const target of mentionTargets) {
      const mentionIdentity = identityKey(target);
      if (target.key === source.key || already.has(target.identifier) || seenTargets.has(mentionIdentity)) continue;
      const edgeKind = suggestedEdge(source, target);
      if (!edgeKind || !mentioned.has(target.identifier)) continue;
      seenTargets.add(mentionIdentity);
      const duplicateTargets = identities.get(mentionIdentity) ?? [];
      if (duplicateTargets.length > 1) {
        addFinding(finding(
          'corpus-reference-ambiguous', source, edgeKind, target.identifier,
          `exact token resolves to multiple ${target.type} artifacts: ${duplicateTargets.map((item) => item.path).sort(stableCompare).join(', ')}`,
        ));
      }
      addFinding(finding(
        'corpus-reference-undeclared', source, edgeKind, target.identifier,
        `exact token matches ${target.type} ${target.identifier}; declare a ${edgeKind} edge for human review`,
      ));
    }
  }

  const unique = new Map<string, GovernanceFinding>();
  for (const value of findings) unique.set(findingKey(value), value);
  return [...unique.values()].sort((a, b) => stableCompare(findingKey(a), findingKey(b)));
}

interface SpecDocument {
  domain: string;
  file: string;
  text: string;
}

function requirementBlocks(spec: SpecDocument): CorpusArtifact[] {
  const matches = [...spec.text.matchAll(/^### Requirement:\s*(\S.*)$/gm)];
  return matches.map((match) => {
    const start = match.index!;
    const following = spec.text.slice(start + match[0].length);
    const nextPeerOrParentHeading = following.match(/^#{1,3}\s+\S.*$/m);
    const end = nextPeerOrParentHeading?.index === undefined
      ? spec.text.length
      : start + match[0].length + nextPeerOrParentHeading.index;
    const name = match[1].trim();
    return {
      key: `requirement:${spec.file}:${start}`,
      type: 'requirement',
      identifier: name,
      identityScope: spec.domain,
      path: spec.file,
      text: spec.text.slice(start, end),
      live: true,
    };
  });
}

function exactDecisionIds(text: string): string[] {
  return [...new Set([...text.matchAll(DECISION_ID_GLOBAL)].map((match) => match[0]))].sort(stableCompare);
}

function declaredRequirementEdges(requirement: CorpusArtifact): CorpusEdge[] {
  const edges: CorpusEdge[] = [];
  for (const line of (requirement.text ?? '').split('\n')) {
    const decision = line.match(/^>\s*(?:Decision recorded|Decision pointer|Decision citation):\s*([0-9a-f]{8})\b/i);
    if (decision) edges.push({ kind: 'spec-cites-decision', sourceKey: requirement.key, reference: decision[1] });
    const anchor = line.match(/^>\s*(Symbol anchor|File anchor):\s*(\S.*?)\s*$/i);
    if (anchor) edges.push({
      kind: 'spec-anchors-symbol',
      sourceKey: requirement.key,
      reference: anchor[2],
      anchorTargetType: anchor[1].toLowerCase().startsWith('symbol') ? 'symbol' : 'file',
    });
    const generic = line.match(/^>\s*Corpus edge:\s*(\S+)\s+(.+?)\s*$/i);
    if (generic) edges.push({ kind: generic[1], sourceKey: requirement.key, reference: generic[2] });
  }
  return edges;
}

function declaredProposalEdges(proposal: CorpusArtifact): CorpusEdge[] {
  const edges: CorpusEdge[] = [];
  for (const line of (proposal.text ?? '').split('\n')) {
    const match = line.match(/^>\s*Corpus edge:\s*(\S+)\s+(.+?)\s*$/i);
    if (match) edges.push({ kind: match[1], sourceKey: proposal.key, reference: match[2] });
  }
  return edges;
}

function declaredNewCapabilities(proposalText: string): string[] {
  const section = proposalText.match(/^### New Capabilities\s*$([\s\S]*?)(?=^### |^## |$(?![\s\S]))/m)?.[1] ?? '';
  return [...new Set([...section.matchAll(/^\s*-\s+`([^`]+)`\s*:/gm)].map((match) => match[1]))]
    .sort(stableCompare);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isDecision(value: unknown): value is PendingDecision {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.status === 'string'
    && typeof value.title === 'string'
    && typeof value.rationale === 'string'
    && typeof value.consequences === 'string'
    && (value.proposedRequirement === null || typeof value.proposedRequirement === 'string')
    && Array.isArray(value.affectedDomains)
    && value.affectedDomains.every((domain) => typeof domain === 'string')
    && Array.isArray(value.affectedFiles)
    && value.affectedFiles.every((file) => typeof file === 'string')
    && isOptionalString(value.supersedes);
}

function isAnchor(value: unknown): value is StructuralAnchor {
  return isRecord(value)
    && typeof value.filePath === 'string'
    && isOptionalString(value.nodeId);
}

function isMemory(value: unknown): value is AnchoredMemory {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && value.kind === 'note'
    && typeof value.content === 'string'
    && Array.isArray(value.anchors)
    && value.anchors.every(isAnchor)
    && isOptionalString(value.invalidatedAt);
}

interface CorpusReadBudget { bytes: number; directoryEntries: number }

async function readCorpusFile(rootPath: string, filePath: string, budget: CorpusReadBudget): Promise<string> {
  const remaining = CORPUS_RESOURCE_LIMITS.totalBytes - budget.bytes;
  const text = await readFileConfined(rootPath, filePath, Math.min(CORPUS_RESOURCE_LIMITS.fileBytes, remaining));
  const bytes = Buffer.byteLength(text);
  if (bytes > CORPUS_RESOURCE_LIMITS.fileBytes) {
    throw new Error(`${filePath} exceeds corpus file limit (${CORPUS_RESOURCE_LIMITS.fileBytes} bytes)`);
  }
  budget.bytes += bytes;
  if (budget.bytes > CORPUS_RESOURCE_LIMITS.totalBytes) {
    throw new Error(`corpus read limit exceeded (${CORPUS_RESOURCE_LIMITS.totalBytes} bytes)`);
  }
  return text;
}

async function readJsonArray<T>(
  rootPath: string,
  filePath: string,
  property: string,
  isEntry: (value: unknown) => value is T,
  budget: CorpusReadBudget,
): Promise<T[]> {
  try {
    const parsed: unknown = JSON.parse(await readCorpusFile(rootPath, filePath, budget));
    if (!isRecord(parsed)) throw new Error(`${filePath} must contain a JSON object`);
    const entries = parsed[property];
    if (!Array.isArray(entries)) throw new Error(`${filePath} must contain a ${property} array`);
    const malformedIndex = entries.findIndex((entry) => !isEntry(entry));
    if (malformedIndex !== -1) throw new Error(`${filePath} has a malformed ${property}[${malformedIndex}] entry`);
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function directories(rootPath: string, filePath: string, budget: CorpusReadBudget): Promise<string[]> {
  try {
    const entries = await readdir(safeJoin(rootPath, filePath), { withFileTypes: true });
    if (entries.length > CORPUS_RESOURCE_LIMITS.directoryEntries) {
      throw new Error(`${filePath} exceeds corpus directory-entry limit (${CORPUS_RESOURCE_LIMITS.directoryEntries})`);
    }
    budget.directoryEntries += entries.length;
    if (budget.directoryEntries > CORPUS_RESOURCE_LIMITS.directoryEntries) {
      throw new Error(`corpus directory-entry limit exceeded (${CORPUS_RESOURCE_LIMITS.directoryEntries})`);
    }
    const symlink = entries.find((entry) => entry.isSymbolicLink());
    if (symlink) throw new Error(`Path escape blocked: symbolic-link directory entry "${join(filePath, symlink.name)}"`);
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(stableCompare);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readSpecs(
  rootPath: string,
  openspecRoot: string,
  budget: CorpusReadBudget,
): Promise<SpecDocument[]> {
  const specsRoot = join(openspecRoot, 'specs');
  const out: SpecDocument[] = [];
  for (const domain of await directories(rootPath, relative(rootPath, specsRoot), budget)) {
    const path = join(specsRoot, domain, 'spec.md');
    try {
      out.push({
        domain,
        file: relative(rootPath, path),
        text: await readCorpusFile(rootPath, relative(rootPath, path), budget),
      });
    } catch (error) {
      // A directory without spec.md is not a domain; other read failures make
      // the assessment unavailable rather than manufacturing unresolved edges.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return out;
}

interface DurableDecision {
  decision: PendingDecision;
  path: string;
  text: string;
}

function durableStatus(value: string | undefined): PendingDecision['status'] {
  if (/^rejected\b/i.test(value ?? '')) return 'rejected';
  if (/^phantom\b/i.test(value ?? '')) return 'phantom';
  return 'synced';
}

function durableDecision(
  id: string,
  status: string | undefined,
  supersedes: string | undefined,
  path: string,
  text: string,
): DurableDecision {
  return {
    decision: {
      id,
      status: durableStatus(status),
      title: '',
      rationale: '',
      consequences: '',
      proposedRequirement: null,
      affectedDomains: [],
      affectedFiles: [],
      supersedes,
      confidence: 'high',
      sessionId: 'durable-corpus',
      recordedAt: '',
      contentOrigin: 'legacy-unknown',
      syncedToSpecs: [path],
    },
    path,
    text,
  };
}

function specDecisionEntries(spec: SpecDocument): DurableDecision[] {
  const out: DurableDecision[] = [];
  for (const match of spec.text.matchAll(/^\*\*ID:\*\*\s*([0-9a-f]{8})\s*$/gm)) {
    const matchIndex = match.index ?? 0;
    const headingIndex = spec.text.lastIndexOf('\n### ', matchIndex);
    const start = headingIndex < 0 ? 0 : headingIndex + 1;
    const remainder = spec.text.slice(matchIndex + match[0].length);
    const nextHeading = remainder.search(/^#{2,3}\s+/m);
    const end = nextHeading < 0
      ? spec.text.length
      : matchIndex + match[0].length + nextHeading;
    const block = spec.text.slice(start, end);
    out.push(durableDecision(
      match[1],
      block.match(/^\*\*Status:\*\*\s*(.+?)\s*$/m)?.[1],
      block.match(/^\*\*Supersedes:\*\*\s*([0-9a-f]{8})\s*$/m)?.[1],
      spec.file,
      block,
    ));
  }
  return out;
}

/**
 * One synced decision is intentionally projected into every affected domain.
 * Entries in distinct affected-domain specs are therefore one durable identity.
 * Repeated entries in one file remain distinct so an actual duplicate record is
 * still reported; content drift between projections is a separate concern.
 */
function coalesceSpecDecisionProjections(entries: readonly DurableDecision[]): DurableDecision[] {
  const groups = new Map<string, DurableDecision[]>();
  for (const entry of entries) {
    const key = entry.decision.id;
    const matches = groups.get(key) ?? [];
    matches.push(entry);
    groups.set(key, matches);
  }
  const out: DurableDecision[] = [];
  for (const matches of groups.values()) {
    const paths = new Set(matches.map((entry) => entry.path));
    if (matches.length > 1 && paths.size === matches.length) {
      out.push([...matches].sort((a, b) => stableCompare(a.path, b.path))[0]);
    } else {
      out.push(...matches);
    }
  }
  return out.sort((a, b) => stableCompare(
    `${a.decision.id}\0${a.path}\0${a.text}`,
    `${b.decision.id}\0${b.path}\0${b.text}`,
  ));
}

async function readADRDecisions(
  rootPath: string,
  openspecRoot: string,
  budget: CorpusReadBudget,
): Promise<DurableDecision[]> {
  const decisionsDir = join(openspecRoot, 'decisions');
  let files: string[];
  try {
    const entries = await readdir(safeJoin(rootPath, relative(rootPath, decisionsDir)));
    if (entries.length > CORPUS_RESOURCE_LIMITS.directoryEntries) {
      throw new Error(`openspec/decisions exceeds corpus directory-entry limit (${CORPUS_RESOURCE_LIMITS.directoryEntries})`);
    }
    files = entries.filter((name) => name.endsWith('.md')).sort(stableCompare);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: DurableDecision[] = [];
  for (const filename of files) {
    const path = join(decisionsDir, filename);
    const text = await readCorpusFile(rootPath, relative(rootPath, path), budget);
    const id = text.match(/^> Decision ID:\s*([0-9a-f]{8})\s*$/m)?.[1];
    if (!id) continue;
    out.push(durableDecision(
      id,
      text.match(/^## Status\s*\n\s*\n([^\n]+)/m)?.[1],
      text.match(/^> Supersedes:\s*([0-9a-f]{8})\s*$/m)?.[1],
      relative(rootPath, path),
      text,
    ));
  }
  return out;
}

export interface DetectCorpusIntegrityOptions {
  openspecPath?: string;
  /** `false` proves absence, `true` proves presence, `undefined` means the graph cannot decide. */
  anchorExists?: (anchor: StructuralAnchor) => boolean | undefined | Promise<boolean | undefined>;
}

/** Read the existing stores/OpenSpec tree and evaluate them without modifying any bytes. */
export async function detectCorpusIntegrity(
  rootPath: string,
  options: DetectCorpusIntegrityOptions = {},
): Promise<GovernanceFinding[]> {
  const openspecRoot = safeJoin(rootPath, options.openspecPath || 'openspec');
  const readBudget: CorpusReadBudget = { bytes: 0, directoryEntries: 0 };
  const [decisions, memories, specs, changeNames, adrDecisions] = await Promise.all([
    readJsonArray(rootPath, join('.openlore', 'decisions', 'pending.json'), 'decisions', isDecision, readBudget),
    readJsonArray(rootPath, join('.openlore', 'memory', 'notes.json'), 'memories', isMemory, readBudget),
    readSpecs(rootPath, openspecRoot, readBudget),
    directories(rootPath, relative(rootPath, join(openspecRoot, 'changes')), readBudget),
    readADRDecisions(rootPath, openspecRoot, readBudget),
  ]);
  const artifacts: CorpusArtifact[] = [];
  const edges: CorpusEdge[] = [];
  const addArtifact = (artifact: CorpusArtifact): void => {
    if (artifacts.length >= CORPUS_RESOURCE_LIMITS.artifacts) {
      throw new Error(`corpus artifact limit exceeded (${CORPUS_RESOURCE_LIMITS.artifacts})`);
    }
    artifacts.push(artifact);
  };
  const addEdges = (values: readonly CorpusEdge[]): void => {
    if (edges.length + values.length > CORPUS_RESOURCE_LIMITS.edges) {
      throw new Error(`corpus edge limit exceeded (${CORPUS_RESOURCE_LIMITS.edges})`);
    }
    edges.push(...values);
  };

  const allSpecDecisions = specs.flatMap(specDecisionEntries);
  const specDecisions = coalesceSpecDecisionProjections(allSpecDecisions);
  const durableById = new Map<string, DurableDecision>();
  for (const durable of [...specDecisions, ...adrDecisions]) {
    if (!durableById.has(durable.decision.id)) durableById.set(durable.decision.id, durable);
  }
  const pendingIds = new Set(decisions.map((decision) => decision.id));
  const durableOnly = [...durableById.values()]
    .filter(({ decision }) => !pendingIds.has(decision.id))
    .sort((a, b) => stableCompare(a.decision.id, b.decision.id));
  const graphDecisions = [...decisions, ...durableOnly.map(({ decision }) => decision)];
  const retirement = buildRetirementGraph(graphDecisions);
  for (const decision of decisions) {
    const artifact: CorpusArtifact = {
      key: `decision:${decision.id}:${artifacts.length}`,
      type: 'decision',
      identifier: decision.id,
      path: '.openlore/decisions/pending.json',
      text: [decision.title, decision.rationale, decision.consequences, decision.proposedRequirement ?? ''].join('\n'),
      live: decision.status !== 'rejected' && decision.status !== 'phantom',
      retiredBy: retirement.supersededBy.get(decision.id)
        ?? (retirement.retiredDecisionIds.has(decision.id) ? decision.id : undefined)
        ?? (decision.status === 'rejected' || decision.status === 'phantom' ? decision.id : undefined),
    };
    addArtifact(artifact);
  }
  const specDecisionCounts = new Map<string, number>();
  const pendingDecisionCounts = new Map<string, number>();
  for (const decision of decisions) {
    pendingDecisionCounts.set(decision.id, (pendingDecisionCounts.get(decision.id) ?? 0) + 1);
  }
  for (const { decision } of specDecisions) {
    specDecisionCounts.set(decision.id, (specDecisionCounts.get(decision.id) ?? 0) + 1);
  }
  for (const spec of specs) {
    addArtifact({ key: `domain:${spec.domain}`, type: 'spec-domain', identifier: spec.domain, path: spec.file, live: true });
    for (const requirement of requirementBlocks(spec)) {
      addArtifact(requirement);
      addEdges(declaredRequirementEdges(requirement));
    }
  }

  // Synced decisions are purged from pending.json after the durable spec write.
  // Their `## Decisions` entries are therefore part of the decision range, not
  // merely prose. Identical cross-domain projections were coalesced above;
  // conflicting or same-file duplicates remain visible here.
  for (const durable of specDecisions) {
    const { decision } = durable;
    const pendingProjection = decisions.find((candidate) => candidate.id === decision.id);
    const atomicTransition = pendingDecisionCounts.get(decision.id) === 1
      && specDecisionCounts.get(decision.id) === 1
      && (pendingProjection?.status === 'synced'
        || pendingProjection?.syncedToSpecs.includes(durable.path));
    if (atomicTransition) continue;
    addArtifact({
      key: `decision-spec:${durable.path}:${artifacts.length}`,
      type: 'decision',
      identifier: decision.id,
      path: durable.path,
      text: durable.text,
      live: decision.status !== 'rejected' && decision.status !== 'phantom',
      retiredBy: retirement.supersededBy.get(decision.id)
        ?? (retirement.retiredDecisionIds.has(decision.id) ? decision.id : undefined)
        ?? (decision.status === 'rejected' || decision.status === 'phantom' ? decision.id : undefined),
    });
  }

  // ADRs are the sole durable representation when a cross-domain/system
  // decision had no resolvable owning spec. A matching spec entry is the same
  // intentional projection, not a second decision artifact.
  for (const durable of adrDecisions) {
    const { decision } = durable;
    if (specDecisionCounts.has(decision.id) || pendingDecisionCounts.has(decision.id)) continue;
    addArtifact({
      key: `decision-adr:${durable.path}:${artifacts.length}`,
      type: 'decision',
      identifier: decision.id,
      path: durable.path,
      text: durable.text,
      live: decision.status !== 'rejected' && decision.status !== 'phantom',
      retiredBy: retirement.supersededBy.get(decision.id)
        ?? (retirement.retiredDecisionIds.has(decision.id) ? decision.id : undefined)
        ?? (decision.status === 'rejected' || decision.status === 'phantom' ? decision.id : undefined),
    });
  }

  for (const decision of graphDecisions) {
    if (!decision.supersedes) continue;
    const source = artifacts.find((artifact) =>
      artifact.type === 'decision' && artifact.identifier === decision.id,
    );
    if (source) addEdges([{
      kind: 'decision-supersedes',
      sourceKey: source.key,
      reference: decision.supersedes!,
    }]);
  }

  // Resolve explicit requirement anchors through the same caller-supplied graph
  // verdict as memory anchors. File anchors remain decidable without an index.
  const unresolvedSpecAnchors = edges.filter((edge) => edge.kind === 'spec-anchors-symbol');
  for (const edge of unresolvedSpecAnchors) {
    let exists: boolean | undefined;
    if (edge.anchorTargetType === 'file') {
      try { exists = (await stat(safeJoin(rootPath, edge.reference))).isFile(); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
        else throw error;
      }
    } else if (edge.anchorTargetType === 'symbol') {
      exists = await options.anchorExists?.({ nodeId: edge.reference, filePath: '' });
    }
    if (exists === false) edge.anchorMissing = true;
    if (exists === true) {
      const type = edge.anchorTargetType!;
      const key = `${type}:${edge.reference}`;
      if (!artifacts.some((candidate) => candidate.key === key)) {
        addArtifact({ key, type, identifier: edge.reference, path: edge.reference, live: true });
      }
    }
  }
  // Unknown symbol state is not an unresolved reference: without a graph there
  // is no evidence either way, so omit that edge from this pass.
  const decidedEdges = edges.filter((edge) =>
    edge.kind !== 'spec-anchors-symbol'
      || edge.anchorMissing !== undefined
      || artifacts.some((candidate) =>
        (candidate.type === 'symbol' || candidate.type === 'file') && candidate.identifier === edge.reference,
      ),
  );
  edges.length = 0;
  edges.push(...decidedEdges);

  for (const memory of memories) {
    const artifact: CorpusArtifact = {
      key: `memory:${memory.id}`,
      type: 'memory',
      identifier: memory.id,
      path: '.openlore/memory/notes.json',
      text: memory.content,
      live: !memory.invalidatedAt,
    };
    addArtifact(artifact);
    let orphaned = false;
    for (const anchor of memory.anchors) {
      const reference = anchor.nodeId ?? anchor.filePath;
      let exists = await options.anchorExists?.(anchor);
      if (exists === undefined && !anchor.nodeId) {
        try { exists = (await stat(safeJoin(rootPath, anchor.filePath))).isFile(); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
          else throw error;
        }
      }
      if (exists === true) {
        const type: CorpusArtifactType = anchor.nodeId ? 'symbol' : 'file';
        const key = `${type}:${reference}`;
        if (!artifacts.some((candidate) => candidate.key === key)) {
          addArtifact({ key, type, identifier: reference, path: anchor.filePath, live: true });
        }
      }
      if (exists === false) orphaned = true;
      // Unknown is intentionally omitted: without an index the pass cannot prove
      // a symbol exists or is missing. File anchors can always be decided above.
      if (exists !== undefined) {
        addEdges([{
          kind: 'memory-anchors-symbol',
          sourceKey: artifact.key,
          reference,
          ...(exists === false ? { anchorMissing: true } : {}),
        }]);
      }
    }
    // Match recall's authority rule: an invalidated or orphaned memory remains
    // diagnosable, but cannot create a live-to-retired liveness finding.
    if (orphaned) artifact.live = false;
    const citations = new Set(exactDecisionIds(memory.content));
    for (const stale of staleRefsInText(memory.content, retirement)) citations.add(stale.retired);
    for (const id of [...citations].sort(stableCompare)) {
      addEdges([{ kind: 'memory-cites-decision', sourceKey: artifact.key, reference: id }]);
    }
  }

  for (const change of changeNames.filter((name) => name !== 'archive')) {
    const changeRoot = join(openspecRoot, 'changes', change);
    try {
      const proposalPath = join(changeRoot, 'proposal.md');
      const text = await readCorpusFile(rootPath, relative(rootPath, proposalPath), readBudget);
      const proposal: CorpusArtifact = {
        key: `proposal:${change}`,
        type: 'proposal',
        identifier: change,
        path: relative(rootPath, proposalPath),
        text,
        live: true,
      };
      addArtifact(proposal);
      addEdges(declaredProposalEdges(proposal));
      for (const domain of declaredNewCapabilities(text)) {
        addArtifact({
          key: `new-domain:${change}:${domain}`,
          type: 'spec-domain',
          identifier: domain,
          path: relative(rootPath, proposalPath),
          live: true,
        });
      }
    } catch (error) {
      // A change need not have a proposal to have a delta. Other failures must
      // not silently turn a declared new capability into an unresolved target.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const domain of await directories(rootPath, relative(rootPath, join(changeRoot, 'specs')), readBudget)) {
      const deltaSpecPath = join(changeRoot, 'specs', domain, 'spec.md');
      const source: CorpusArtifact = {
        key: `delta:${change}:${domain}`,
        type: 'change-delta',
        identifier: `${change}/${domain}`,
        path: relative(rootPath, join(changeRoot, 'specs', domain)),
        live: true,
      };
      addArtifact(source);
      addEdges([{ kind: 'change-delta-targets-domain', sourceKey: source.key, reference: domain }]);
      try {
        const deltaSpec: SpecDocument = {
          domain: `${domain}@change:${change}`,
          file: relative(rootPath, deltaSpecPath),
          text: await readCorpusFile(rootPath, relative(rootPath, deltaSpecPath), readBudget),
        };
        for (const requirement of requirementBlocks(deltaSpec)) {
          addArtifact(requirement);
          addEdges(declaredRequirementEdges(requirement));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  return evaluateCorpusGraph({ artifacts, edges });
}
