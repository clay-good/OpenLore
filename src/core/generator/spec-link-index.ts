/**
 * Deterministic spec link index.
 *
 * Replaces the LLM-pipeline-owned requirement mapping with a pure function of
 * (existing specs, current analysis graph). Every link comes from an anchor a
 * human or agent wrote explicitly in the spec — never from name similarity,
 * embeddings, or an LLM. That makes coverage an OBSERVATION rather than an
 * inference, and makes Repair usable without a prior probabilistic Generate run.
 *
 * Resolution is intentionally conservative (change `harden-spec-workflow-lifecycle`,
 * decision 671084e7):
 *
 *   - exact anchor resolving to exactly one graph identity → `linked`
 *   - anchor resolving to several exact identities         → `ambiguous`
 *   - anchor naming an exported TYPE (not behaviour)       → `type-only`
 *   - anchor whose identity is absent from the graph       → `stale`
 *   - requirement with no exact symbol anchor at all       → `unmapped`
 *
 * A file-only anchor contributes to the domain FOOTPRINT and never to function
 * coverage: citing `src/auth/session.ts` does not make every function in that
 * file covered.
 *
 * This module is pure and does no I/O so it can be exercised directly by unit
 * fixtures; callers supply already-read spec content and the cached graph.
 */

import { createHash } from 'node:crypto';
import { isAbsolute, posix } from 'node:path';

import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import { detectLanguage } from '../analyzer/language-detection.js';
import { parseRequirementBlocks } from '../drift/spec-mapper.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Schema version of the persisted deterministic link index.
 *
 * BUMP THIS whenever the MEANING of the artifact changes — including a change to
 * how anchors are parsed or resolved, not only to the field layout. The cache's
 * provenance binds the analysis generation and the spec CONTENT, so a code change
 * that reinterprets unchanged specs is invisible to it; the version is the only
 * thing that invalidates such a cache.
 *
 * History:
 *   3 — deterministic anchors replace the LLM/semantic/heuristic mapping
 *   4 — legacy `> Implementation: \`name\` in \`file\`` hints are read too
 *   5 — a dotted `Class.method` token resolves as a member identity when the
 *       graph holds it, instead of always being read as a file path
 *   6 — an anchor naming an exported type resolves to `type-only` instead of
 *       `stale`: the type exists, it is merely outside what coverage measures
 */
export const SPEC_LINK_INDEX_VERSION = 6;

/** Default bound on disclosed candidates for one ambiguous or stale anchor. */
export const SPEC_LINK_MAX_CANDIDATES = 5;

export type SpecLinkState = 'linked' | 'ambiguous' | 'unmapped' | 'stale';

/** Why one anchor did not resolve to a single identity. */
export type SpecAnchorState =
  | 'linked'
  | 'ambiguous'
  | 'stale'
  /** A file-only anchor: domain footprint, never function coverage. */
  | 'footprint'
  /**
   * The anchored name EXISTS but is a type declaration, so it is outside what
   * coverage measures. Distinct from `stale`, which asserts the cited symbol is
   * gone — saying that about a type that is right there is simply false.
   */
  | 'type-only';

export interface SpecSymbolRef {
  name: string;
  /** Normalized repo-relative POSIX path. */
  file: string;
  line: number;
  kind: string;
}

export interface SpecLinkAnchor {
  /** The anchor exactly as written in the spec. */
  raw: string;
  /** Normalized repo-relative path, or `null` when the anchor names only a symbol. */
  file: string | null;
  /** Exact symbol name, or `null` for a file-only anchor. */
  symbol: string | null;
  state: SpecAnchorState;
  /** Bounded exact-name candidates disclosed for `ambiguous` / `stale`. */
  candidates: SpecSymbolRef[];
  /** Total exact matches before the candidate bound was applied. */
  candidateTotal: number;
}

export interface SpecRequirementLink {
  requirement: string;
  domain: string;
  /** Repo-relative path of the spec that declares the requirement. */
  specFile: string;
  state: SpecLinkState;
  anchors: SpecLinkAnchor[];
  /** Symbols established as covered — only uniquely-resolved exact anchors. */
  functions: SpecSymbolRef[];
  /** Files contributed to the domain footprint by file-only anchors. Never coverage. */
  footprintFiles: string[];
}

export interface SpecLinkIndexProvenance {
  /** Identity of the committed analysis generation the anchors were resolved against. */
  analysisGeneration: string;
  /** Digest over every parsed spec's content, so a spec edit invalidates the cache. */
  specDigest: string;
  /**
   * Legacy export-inventory fingerprint, retained so a v2 consumer can still tell
   * whether the artifact describes its analysis.
   */
  sourceAnalysisFingerprint?: string;
}

export interface SpecLinkIndexStats {
  totalRequirements: number;
  linked: number;
  ambiguous: number;
  unmapped: number;
  stale: number;
  /** Exported, non-type symbols in the analyzed graph. */
  totalExportedFunctions: number;
  /** Distinct symbols covered by at least one uniquely-resolved anchor. */
  coveredFunctions: number;
  orphanCount: number;
  /** Distinct files reached by file-only anchors. */
  footprintFileCount: number;
}

export interface SpecLinkIndex {
  version: typeof SPEC_LINK_INDEX_VERSION;
  generatedAt: string;
  provenance: SpecLinkIndexProvenance;
  links: SpecRequirementLink[];
  /** Exported symbols no requirement anchors. */
  orphanFunctions: SpecSymbolRef[];
  stats: SpecLinkIndexStats;
}

export interface SpecLinkIndexSpecInput {
  domain: string;
  /** Repo-relative path of the spec file. */
  specFile: string;
  content: string;
}

export interface SpecLinkIndexInput {
  specs: SpecLinkIndexSpecInput[];
  graph: DependencyGraphResult;
  /** Identity of the analysis generation being resolved against. */
  analysisGeneration: string;
  /** Legacy export-inventory fingerprint, recorded for compatibility reporting. */
  sourceAnalysisFingerprint?: string;
  maxCandidates?: number;
  /** Injected only by tests that need a stable `generatedAt`. */
  now?: () => Date;
}

// ============================================================================
// NORMALIZATION
// ============================================================================

/** One raw anchor token split into the parts a resolver can act on. */
export interface ParsedSpecAnchor {
  /** Normalized repo-relative path, or `null` when the token names only a symbol. */
  file: string | null;
  /** Exact symbol name, or `null` for a file-only anchor. */
  symbol: string | null;
  /**
   * Set only for a slash-free dotted token whose shape fits BOTH a file and a
   * member identity. The parser records both readings; the resolver picks the
   * symbol one only when the graph actually holds that exact name.
   */
  memberCandidate?: string;
}

/**
 * Normalize an anchor path to a repo-relative POSIX path, or `null` when it
 * escapes the repository (absolute, drive-qualified, or `..`-relative). A path
 * that cannot be confined is dropped rather than resolved — an anchor is only
 * ever evidence about this repository.
 */
export function normalizeAnchorPath(value: string): string | null {
  const slashed = value.replaceAll('\\', '/').trim();
  if (!slashed) return null;
  if (isAbsolute(slashed) || /^[A-Za-z]:\//.test(slashed)) return null;
  const normalized = posix.normalize(slashed.replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

/** A token that looks like a path rather than a bare identifier. */
function looksLikePath(token: string): boolean {
  return token.includes('/') || /\.[A-Za-z0-9]+$/.test(token);
}

/** `Class.method`, `Outer.Inner.run` — the dotted member identities the graph names. */
const MEMBER_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

/**
 * A slash-free dotted token that could be read EITHER way.
 *
 * `utils.py` is a file; `Class.method` is a method identity — and the two are
 * indistinguishable by shape. A known code extension settles it as a file; every
 * other dotted token is recorded as both readings and settled against the graph
 * by {@link resolveAnchor}, never by guessing at the shape.
 */
function memberCandidateOf(token: string): string | undefined {
  if (token.includes('/')) return undefined;
  if (detectLanguage(token) !== 'unknown') return undefined;
  return MEMBER_CHAIN.test(token) ? token : undefined;
}

/**
 * Parse one raw anchor token into its path and symbol parts.
 *
 * Accepted forms, in resolution order:
 *   - `name::path/to/file.ts` — the house `name::path` convention used by the
 *     navigation tools, so a spec anchor reads the same as a tool argument
 *   - `path/to/file.ts#name` — the familiar document-fragment form
 *   - `path/to/file.ts`      — file-only, footprint evidence only
 *   - `name`                 — a bare exact symbol name, resolved graph-wide
 *   - `Class.method`         — a dotted token that is BOTH readings until the
 *     graph settles it (see {@link memberCandidateOf})
 *
 * An unparseable or repo-escaping token yields `null` and is ignored.
 */
export function parseSpecAnchor(raw: string): ParsedSpecAnchor | null {
  const token = raw.trim();
  if (!token) return null;

  const doubleColon = token.indexOf('::');
  if (doubleColon > 0) {
    const symbol = token.slice(0, doubleColon).trim();
    const file = normalizeAnchorPath(token.slice(doubleColon + 2));
    return symbol && file ? { file, symbol } : null;
  }

  const hash = token.indexOf('#');
  if (hash > 0) {
    const file = normalizeAnchorPath(token.slice(0, hash));
    const symbol = token.slice(hash + 1).trim();
    return file && symbol ? { file, symbol } : null;
  }

  if (looksLikePath(token)) {
    const file = normalizeAnchorPath(token);
    if (!file) return null;
    const memberCandidate = memberCandidateOf(token);
    return { file, symbol: null, ...(memberCandidate ? { memberCandidate } : {}) };
  }

  // A bare identifier is an exact symbol anchor with no path constraint.
  return /^[A-Za-z_$][\w$.]*$/.test(token) ? { file: null, symbol: token } : null;
}

/**
 * Digest over the parsed specs. Bound into provenance so any spec edit makes a
 * persisted index recognizably stale without re-deriving it.
 */
export function specCorpusDigest(specs: SpecLinkIndexSpecInput[]): string {
  const hash = createHash('sha256');
  for (const spec of [...specs].sort((a, b) => a.specFile.localeCompare(b.specFile))) {
    hash.update(spec.specFile).update('\0').update(spec.content).update('\0');
  }
  return hash.digest('hex');
}

// ============================================================================
// BUILDER
// ============================================================================

const compareRefs = (a: SpecSymbolRef, b: SpecSymbolRef): number =>
  a.file.localeCompare(b.file) || a.name.localeCompare(b.name) || a.line - b.line;

/**
 * Index the graph's exported symbols by exact name, keeping VALUES and TYPES
 * apart.
 *
 * Coverage is about behaviour, so only values can establish it. But a type still
 * has to be findable: an anchor naming one must be answerable with "that exists
 * and is a type", not with `stale`, which claims the cited symbol is gone.
 */
function buildExportIndex(graph: DependencyGraphResult): {
  values: Map<string, SpecSymbolRef[]>;
  types: Map<string, SpecSymbolRef[]>;
} {
  const values = new Map<string, SpecSymbolRef[]>();
  const types = new Map<string, SpecSymbolRef[]>();
  for (const node of graph.nodes) {
    const file = normalizeAnchorPath(node.file.path);
    if (!file) continue;
    for (const exported of node.exports) {
      const ref: SpecSymbolRef = { name: exported.name, file, line: exported.line, kind: exported.kind };
      const target = exported.isType ? types : values;
      const existing = target.get(exported.name);
      if (existing) existing.push(ref);
      else target.set(exported.name, [ref]);
    }
  }
  for (const refs of values.values()) refs.sort(compareRefs);
  for (const refs of types.values()) refs.sort(compareRefs);
  return { values, types };
}

/**
 * A resolver over the graph's exported symbols that answers only with certainty.
 *
 * Returns the symbol when the name (optionally constrained to a file) identifies
 * exactly ONE exported identity, and `null` when it identifies none or several.
 * Used by standalone generation to verify an LLM-proposed function name before
 * writing it into a spec as an anchor: an unverifiable proposal is written as no
 * anchor at all rather than as a probabilistic one.
 */
export function buildSymbolResolver(
  graph: DependencyGraphResult,
): (name: string, file?: string | null) => SpecSymbolRef | null {
  const exportIndex = buildExportIndex(graph).values;
  return (name, file) => {
    const byName = exportIndex.get(name) ?? [];
    const normalized = file ? normalizeAnchorPath(file) : null;
    const matches = normalized ? byName.filter(ref => ref.file === normalized) : byName;
    return matches.length === 1 ? matches[0] : null;
  };
}

/** Render a symbol as the canonical `name::path` spec anchor. */
export function formatSpecAnchor(ref: SpecSymbolRef): string {
  return `${ref.name}::${ref.file}`;
}

/**
 * Exact anchors a generator verified against the graph, keyed by requirement.
 *
 * Only verified entries exist: a proposal that did not resolve to exactly one
 * symbol is absent from the map, so the spec is written with no anchor for that
 * requirement rather than with a guessed one.
 */
export type VerifiedRequirementAnchors = ReadonlyMap<string, SpecSymbolRef>;

/** Key requirements the same way on both the write and the read side. */
export function requirementAnchorKey(domain: string, requirement: string): string {
  return `${domain.toLowerCase()}\0${requirement.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

/** Resolve one anchor against the export index. No fallback, no similarity. */
function resolveAnchor(
  raw: string,
  parsed: ParsedSpecAnchor,
  exportIndex: { values: Map<string, SpecSymbolRef[]>; types: Map<string, SpecSymbolRef[]> },
  maxCandidates: number,
): SpecLinkAnchor {
  if (!parsed.symbol) {
    // A both-readings token (`Class.method`) becomes a symbol anchor ONLY when the
    // graph holds that exact name. Unresolved, it stays file-footprint evidence
    // rather than being asserted as a stale symbol the spec may never have cited.
    const member = parsed.memberCandidate;
    if (member && (exportIndex.values.get(member)?.length ?? 0) > 0) {
      return resolveAnchor(raw, { file: null, symbol: member }, exportIndex, maxCandidates);
    }
    return { raw, file: parsed.file, symbol: null, state: 'footprint', candidates: [], candidateTotal: 0 };
  }

  const byName = exportIndex.values.get(parsed.symbol) ?? [];
  const matches = parsed.file ? byName.filter(ref => ref.file === parsed.file) : byName;

  if (matches.length === 1) {
    return { raw, file: parsed.file, symbol: parsed.symbol, state: 'linked', candidates: [matches[0]], candidateTotal: 1 };
  }
  if (matches.length > 1) {
    return {
      raw, file: parsed.file, symbol: parsed.symbol, state: 'ambiguous',
      candidates: matches.slice(0, maxCandidates), candidateTotal: matches.length,
    };
  }
  // Before calling it gone: is the name a TYPE? Types are excluded from coverage
  // because coverage is about behaviour, but they are not missing. Reporting
  // `stale` — "the spec cites something that no longer exists" — for a type that is
  // right there would be a false statement, so it gets its own state and discloses
  // where the type lives.
  const typeRefs = exportIndex.types.get(parsed.symbol) ?? [];
  const typeMatches = parsed.file ? typeRefs.filter(ref => ref.file === parsed.file) : typeRefs;
  if (typeMatches.length > 0) {
    return {
      raw, file: parsed.file, symbol: parsed.symbol, state: 'type-only',
      candidates: typeMatches.slice(0, maxCandidates), candidateTotal: typeMatches.length,
    };
  }

  // The cited identity is absent. Same-name symbols elsewhere are disclosed as
  // candidates so a human can see where it moved — they are NOT auto-selected.
  return {
    raw, file: parsed.file, symbol: parsed.symbol, state: 'stale',
    candidates: byName.slice(0, maxCandidates), candidateTotal: byName.length,
  };
}

/**
 * Requirement state from its anchors. A cited-but-absent identity is the strongest
 * signal (the spec claims something that no longer exists), so `stale` outranks
 * `ambiguous`, which outranks `linked`.
 */
function requirementState(anchors: SpecLinkAnchor[]): SpecLinkState {
  const symbolAnchors = anchors.filter(anchor => anchor.symbol !== null);
  if (symbolAnchors.length === 0) return 'unmapped';
  if (symbolAnchors.some(anchor => anchor.state === 'stale')) return 'stale';
  if (symbolAnchors.some(anchor => anchor.state === 'ambiguous')) return 'ambiguous';
  // A requirement anchored ONLY to types establishes no function coverage, but it
  // cites nothing missing either: `unmapped` says exactly that, where `stale`
  // would accuse the spec of naming something gone.
  if (symbolAnchors.every(anchor => anchor.state === 'type-only')) return 'unmapped';
  return 'linked';
}

/**
 * Build the deterministic link index. Pure: same specs plus same graph always
 * produce the same index, modulo `generatedAt`.
 */
export function buildSpecLinkIndex(input: SpecLinkIndexInput): SpecLinkIndex {
  const maxCandidates = Math.max(1, input.maxCandidates ?? SPEC_LINK_MAX_CANDIDATES);
  const exportIndex = buildExportIndex(input.graph);

  const links: SpecRequirementLink[] = [];
  const coveredKeys = new Set<string>();

  for (const spec of input.specs) {
    for (const block of parseRequirementBlocks(spec.content)) {
      const anchors: SpecLinkAnchor[] = [];
      for (const raw of block.anchors) {
        const parsed = parseSpecAnchor(raw);
        if (!parsed) continue;
        anchors.push(resolveAnchor(raw, parsed, exportIndex, maxCandidates));
      }

      const functions = anchors
        .filter(anchor => anchor.state === 'linked')
        .map(anchor => anchor.candidates[0])
        .sort(compareRefs);
      for (const ref of functions) coveredKeys.add(`${ref.name}\0${ref.file}`);

      const footprintFiles = [...new Set(
        anchors.filter(anchor => anchor.file !== null).map(anchor => anchor.file as string),
      )].sort();

      links.push({
        requirement: block.name,
        domain: spec.domain,
        specFile: spec.specFile,
        state: requirementState(anchors),
        anchors,
        functions,
        footprintFiles,
      });
    }
  }

  links.sort((a, b) => a.specFile.localeCompare(b.specFile) || a.requirement.localeCompare(b.requirement));

  // Orphans are VALUES only: a type was never a coverage candidate, so listing it
  // as uncovered would invent a gap that cannot be closed.
  const allExports = [...exportIndex.values.values()].flat();
  const orphanFunctions = allExports
    .filter(ref => !coveredKeys.has(`${ref.name}\0${ref.file}`))
    .sort(compareRefs);

  const countState = (state: SpecLinkState): number => links.filter(link => link.state === state).length;
  const footprintFiles = new Set(links.flatMap(link => link.footprintFiles));

  return {
    version: SPEC_LINK_INDEX_VERSION,
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    provenance: {
      analysisGeneration: input.analysisGeneration,
      specDigest: specCorpusDigest(input.specs),
      ...(input.sourceAnalysisFingerprint ? { sourceAnalysisFingerprint: input.sourceAnalysisFingerprint } : {}),
    },
    links,
    orphanFunctions,
    stats: {
      totalRequirements: links.length,
      linked: countState('linked'),
      ambiguous: countState('ambiguous'),
      unmapped: countState('unmapped'),
      stale: countState('stale'),
      totalExportedFunctions: allExports.length,
      coveredFunctions: coveredKeys.size,
      orphanCount: orphanFunctions.length,
      footprintFileCount: footprintFiles.size,
    },
  };
}

// ============================================================================
// LEGACY COMPATIBILITY
// ============================================================================

export type MappingArtifactRead =
  | { kind: 'link-index'; index: SpecLinkIndex }
  | {
      kind: 'legacy';
      version?: number;
      generatedAt?: string;
      sourceAnalysisFingerprint?: string;
      reason: 'incompatible-provenance';
    }
  | { kind: 'invalid'; reason: 'invalid-json' };

/**
 * Read a persisted `mapping.json` without trusting it.
 *
 * A v3 artifact is returned as a link index. A v1/v2 artifact is reported as
 * legacy provenance — never converted, because its links were produced by LLM,
 * semantic, and name-similarity matching that this schema deliberately refuses
 * to treat as coverage. Unparseable content is `invalid-json`.
 */
export function readMappingArtifact(raw: string): MappingArtifactRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: 'invalid-json' };
  }
  const record = parsed as Record<string, unknown>;

  if (record.version === SPEC_LINK_INDEX_VERSION && Array.isArray(record.links)) {
    const provenance = record.provenance;
    const hasProvenance = !!provenance && typeof provenance === 'object'
      && typeof (provenance as Record<string, unknown>).analysisGeneration === 'string'
      && typeof (provenance as Record<string, unknown>).specDigest === 'string';
    if (hasProvenance) return { kind: 'link-index', index: record as unknown as SpecLinkIndex };
    return { kind: 'invalid', reason: 'invalid-json' };
  }

  return {
    kind: 'legacy',
    ...(typeof record.version === 'number' ? { version: record.version } : {}),
    ...(typeof record.generatedAt === 'string' ? { generatedAt: record.generatedAt } : {}),
    ...(typeof record.sourceAnalysisFingerprint === 'string'
      ? { sourceAnalysisFingerprint: record.sourceAnalysisFingerprint } : {}),
    reason: 'incompatible-provenance',
  };
}

/**
 * Is a persisted index still describing the current inputs? Both the analysis
 * generation and the spec digest must match — a spec edit alone invalidates it.
 */
export function isLinkIndexCurrent(
  index: SpecLinkIndex,
  analysisGeneration: string,
  specDigest: string,
): boolean {
  // The version is checked here as well as in `readMappingArtifact` so the
  // "is this cache still true?" question has ONE complete answer: same schema
  // meaning, same analysis, same specs.
  return index.version === SPEC_LINK_INDEX_VERSION
    && index.provenance.analysisGeneration === analysisGeneration
    && index.provenance.specDigest === specDigest;
}
