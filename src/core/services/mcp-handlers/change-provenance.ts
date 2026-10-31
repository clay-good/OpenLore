/**
 * certify_provenance — a reproducible, content-addressed record of what a change DOES
 * (change: add-change-provenance-certificate).
 *
 * Supply-chain provenance (SLSA / in-toto / Sigstore) attests who/what produced a change; it does
 * not say what the change does to the code. This emits the missing SEMANTIC half: the structural
 * delta, blast radius, the paths the change opens into a declared surface, the specs it drifts, and
 * the tests that reach it — composed from `change_impact_certificate` (which already folds in
 * blast_radius) plus `structural_diff`.
 *
 * Two properties make it provenance rather than a briefing:
 *   - REPRODUCIBLE + CONTENT-ADDRESSED: the predicate is serialized canonically (sorted keys) and
 *     hashed (sha256), so any consumer can recompute it and verify the digest — the certificate is
 *     checkable, not merely signed.
 *   - PORTABLE: it is shaped as an in-toto predicate (stable `predicateType`) for attachment to the
 *     repo's existing SLSA/in-toto attestation, or emitted as standalone JSON.
 *
 * OpenLore emits the document and performs NO signing (that stays with the repo's cosign/Sigstore
 * flow). A bad base is fatal (never a fallback certification). Boundaries are disclosed, so the
 * claim is a sound lower bound, never "safe". Sibling: `change_impact_certificate` briefs the
 * author's pending diff in-session; this emits the portable, recomputable attestation.
 */

import { createHash } from 'node:crypto';

import { computeImpactCertificate, type ImpactCertificate } from './impact-certificate.js';
import { handleStructuralDiff } from './structural-diff.js';

/** Stable predicate type for the in-toto statement. */
export const PROVENANCE_PREDICATE_TYPE = 'https://openlore.dev/change-provenance/v1';
const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';

export interface ChangeProvenanceInput {
  directory: string;
  baseRef?: string;
  change?: string;
  allowBaseFallback?: boolean;
  format?: 'in-toto' | 'json';
}

interface StructuralSummary {
  addedFunctions: number;
  removedFunctions: number;
  signatureChanges: number;
  deprecatedCallsAdded: number;
}

interface StructuralDiffShape {
  summary?: Partial<StructuralSummary>;
  error?: string;
}

/**
 * Deterministic JSON with lexicographically sorted object keys, so the digest is stable regardless
 * of key insertion order. Arrays keep their order (it is already deterministic upstream).
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return null; // defensive: never recurse a cycle
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = norm((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

/**
 * Build the provenance predicate and its content-address digest from an impact certificate and the
 * structural delta. Pure — same inputs produce a byte-identical predicate and digest.
 */
export function buildProvenanceDocument(
  cert: ImpactCertificate,
  structural: StructuralSummary | { unavailable: string },
): { predicate: Record<string, unknown>; digest: string } {
  const predicate: Record<string, unknown> = {
    producer: 'openlore',
    schema: 'change-provenance/v1',
    baseRef: cert.baseRef,
    resolvedBaseRef: cert.resolvedBaseRef,
    change: cert.change,
    changed: cert.changed,
    structuralDelta: structural,
    surfaces: cert.surfaces,
    newlyOpenedPaths: cert.newlyOpenedPaths,
    impact: cert.impact,
    specs: cert.specs,
    tests: cert.tests,
    findings: cert.findings,
    highestSurfaceSeverity: cert.highestSurfaceSeverity,
    boundaries: cert.caveats,
    ...(cert.dynamicBoundaries ? { dynamicBoundaries: cert.dynamicBoundaries } : {}),
    ...(cert.baseRefFallback ? { baseRefFallback: cert.baseRefFallback } : {}),
  };
  const digest = createHash('sha256').update(canonicalJson(predicate)).digest('hex');
  return { predicate, digest };
}

/**
 * Emit the semantic change-provenance certificate for a commit range. Returns a conclusion-shaped
 * object; a failed impact certificate (e.g. an unresolvable base) is returned as an error, never a
 * partial certification.
 */
export async function handleCertifyProvenance(
  input: ChangeProvenanceInput,
): Promise<Record<string, unknown>> {
  const cert = await computeImpactCertificate({
    directory: input.directory,
    baseRef: input.baseRef,
    change: input.change,
    allowBaseFallback: input.allowBaseFallback,
    // Read-only: certify_provenance emits a document, it never persists the impact certificate.
    persist: false,
  });
  if ('error' in cert) {
    return { tool: 'certify_provenance', posture: 'advisory', error: cert.error };
  }

  const sd = (await handleStructuralDiff({
    directory: input.directory,
    baseRef: input.baseRef,
  })) as StructuralDiffShape;
  const structural: StructuralSummary | { unavailable: string } = sd.error
    ? { unavailable: sd.error }
    : {
      addedFunctions: sd.summary?.addedFunctions ?? 0,
      removedFunctions: sd.summary?.removedFunctions ?? 0,
      signatureChanges: sd.summary?.signatureChanges ?? 0,
      deprecatedCallsAdded: sd.summary?.deprecatedCallsAdded ?? 0,
    };

  const { predicate, digest } = buildProvenanceDocument(cert, structural);

  if (input.format === 'in-toto') {
    return {
      tool: 'certify_provenance',
      posture: 'advisory',
      // The subject names the certified change range; its digest is the content address of THIS
      // predicate (recompute-to-verify), not a file hash — stated so a consumer reads it correctly.
      statement: {
        _type: IN_TOTO_STATEMENT_TYPE,
        subject: [{ name: `${cert.resolvedBaseRef}..${cert.change}`, digest: { sha256: digest } }],
        predicateType: PROVENANCE_PREDICATE_TYPE,
        predicate,
      },
      note: 'in-toto predicate; OpenLore emits but does not sign. The subject digest is the content address of the predicate body — recompute to verify.',
    };
  }

  return {
    tool: 'certify_provenance',
    posture: 'advisory',
    predicateType: PROVENANCE_PREDICATE_TYPE,
    digest,
    predicate,
    note: 'Reproducible semantic change provenance. The digest is the content address of the semantic footprint (blast radius + structural delta), not of the diff text, so two edits with the same footprint share a digest. Recompute over the same base to verify. OpenLore emits but does not sign; attach via your existing SLSA/in-toto flow with --format in-toto.',
  };
}
