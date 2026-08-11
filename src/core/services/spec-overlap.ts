/**
 * Deterministic overlap between a candidate generated domain and existing specs.
 *
 * A detected technical domain such as `components` routinely shares files and
 * symbols with several existing business specs. Silently generating a competing
 * spec loses that information; so does suppressing the domain by name. This
 * module reports the overlap as EVIDENCE and decides nothing: no score promotes,
 * merges, renames, or suppresses a domain — the host agent judges (change
 * `harden-spec-workflow-lifecycle`, decision ff9d89a3).
 *
 * Existing spec footprints come from canonical sources only — the `> Source
 * files:` header, `**Implementation**:` references, and the exact symbols of the
 * deterministic link index. Nothing is inferred from spec prose or file naming.
 */

import { isAbsolute, posix } from 'node:path';

import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import { parseSpecHeader, parseSpecReferences } from '../drift/spec-mapper.js';
import type { SpecLinkIndex } from '../generator/spec-link-index.js';
import type { SpecLinkIndexSpecInput } from '../generator/spec-link-index.js';

/** Shared entries disclosed per existing spec before the list is summarized. */
export const MAX_SHARED_ENTRIES = 50;

export interface SpecOverlapObservation {
  /** Existing spec domain that shares footprint with the candidate. */
  domain: string;
  specFile: string;
  /** Files in both footprints, bounded. */
  sharedFiles: string[];
  sharedFileTotal: number;
  /** Exact symbols in both footprints, bounded. Ranked ahead of file-only overlap. */
  sharedSymbols: Array<{ name: string; file: string }>;
  sharedSymbolTotal: number;
  /** Where the existing spec's footprint came from. */
  basis: Array<'source-header' | 'implementation-reference' | 'link-index-symbol'>;
}

export interface SpecOverlapResult {
  observations: SpecOverlapObservation[];
  provenance: {
    /** `available` even when nothing overlaps — an empty result is an observation. */
    state: 'available' | 'unavailable';
    reason?: string;
    /** Existing specs actually compared. */
    comparedSpecs: number;
    /** Candidate footprint sizes the comparison ran against. */
    candidateFiles: number;
    candidateSymbols: number;
    /** False when any compared spec's footprint could not be fully established. */
    complete: boolean;
    basis: string[];
  };
}

function normalize(value: string): string | null {
  const slashed = value.replaceAll('\\', '/').trim();
  if (!slashed || isAbsolute(slashed) || /^[A-Za-z]:\//.test(slashed)) return null;
  const normalized = posix.normalize(slashed.replace(/^\.\//, ''));
  return normalized === '..' || normalized.startsWith('../') ? null : normalized;
}

const normalizeAll = (values: string[]): string[] =>
  [...new Set(values.map(normalize).filter((value): value is string => value !== null))];

/**
 * Compute overlap observations for one candidate domain footprint.
 *
 * `candidateFiles` is the reconciled domain's file set; `candidateSymbols` are
 * the exported symbols those files define. Existing specs whose domain equals the
 * candidate's are skipped — regenerating a domain is not an overlap with itself.
 */
export function computeSpecOverlapObservations(args: {
  candidateDomain: string;
  candidateFiles: string[];
  graph: DependencyGraphResult;
  specs: SpecLinkIndexSpecInput[];
  linkIndex: SpecLinkIndex | null;
}): SpecOverlapResult {
  const candidateFiles = new Set(normalizeAll(args.candidateFiles));

  // Symbols the candidate would claim: every exported, non-type symbol its files define.
  const candidateSymbols = new Map<string, { name: string; file: string }>();
  for (const node of args.graph.nodes) {
    const file = normalize(node.file.path);
    if (!file || !candidateFiles.has(file)) continue;
    for (const exported of node.exports) {
      if (exported.isType) continue;
      candidateSymbols.set(`${exported.name}\0${file}`, { name: exported.name, file });
    }
  }

  const linksByDomain = new Map<string, SpecLinkIndex['links']>();
  for (const link of args.linkIndex?.links ?? []) {
    linksByDomain.set(link.domain, [...(linksByDomain.get(link.domain) ?? []), link]);
  }

  const observations: SpecOverlapObservation[] = [];
  let complete = true;

  for (const spec of args.specs) {
    if (spec.domain.toLowerCase() === args.candidateDomain.toLowerCase()) continue;

    const header = parseSpecHeader(spec.content);
    const references = parseSpecReferences(spec.content);
    const basis: SpecOverlapObservation['basis'] = [];
    if (header.sourceFiles.length > 0) basis.push('source-header');
    if (references.files.length > 0) basis.push('implementation-reference');

    const specFiles = new Set(normalizeAll([...header.sourceFiles, ...references.files]));
    const specSymbols = new Map<string, { name: string; file: string }>();
    for (const link of linksByDomain.get(spec.domain) ?? []) {
      for (const fn of link.functions) specSymbols.set(`${fn.name}\0${fn.file}`, { name: fn.name, file: fn.file });
    }
    if (specSymbols.size > 0) basis.push('link-index-symbol');

    // A spec that declares no canonical footprint at all cannot be compared; say so
    // rather than reporting a confident empty overlap for it.
    if (specFiles.size === 0 && specSymbols.size === 0) {
      complete = false;
      continue;
    }

    const sharedFiles = [...specFiles].filter(file => candidateFiles.has(file)).sort();
    const sharedSymbols = [...specSymbols.entries()]
      .filter(([key]) => candidateSymbols.has(key))
      .map(([, value]) => value)
      .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

    if (sharedFiles.length === 0 && sharedSymbols.length === 0) continue;

    observations.push({
      domain: spec.domain,
      specFile: spec.specFile,
      sharedFiles: sharedFiles.slice(0, MAX_SHARED_ENTRIES),
      sharedFileTotal: sharedFiles.length,
      sharedSymbols: sharedSymbols.slice(0, MAX_SHARED_ENTRIES),
      sharedSymbolTotal: sharedSymbols.length,
      basis,
    });
  }

  // Exact-symbol intersections are the stronger signal, so they rank first.
  observations.sort((a, b) =>
    b.sharedSymbolTotal - a.sharedSymbolTotal
    || b.sharedFileTotal - a.sharedFileTotal
    || a.domain.localeCompare(b.domain));

  return {
    observations,
    provenance: {
      state: 'available',
      comparedSpecs: args.specs.filter(spec => spec.domain.toLowerCase() !== args.candidateDomain.toLowerCase()).length,
      candidateFiles: candidateFiles.size,
      candidateSymbols: candidateSymbols.size,
      complete,
      basis: ['source-header', 'implementation-reference', 'link-index-symbol'],
    },
  };
}
