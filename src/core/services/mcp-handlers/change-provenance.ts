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
 *     repo's existing SLSA/in-toto attestation, or emitted as standalone JSON. With
 *     `format: 'in-toto'` the predicate is wrapped in an in-toto Statement v1 envelope whose SHAPE
 *     is checked locally on every emission (`validateInTotoStatement`, disclosed as
 *     `statementValidation`) — a structural check of the envelope, not schema validation, not a
 *     signature, and not a claim that the subject digest identifies a built artifact.
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

/** The named structural check `validateInTotoStatement` performs. Emitted as a receipt. */
export const IN_TOTO_STATEMENT_CHECK = 'in-toto-statement-v1-structural';

/** Hex length of a digest for each algorithm whose output size is fixed and known here. */
const DIGEST_HEX_LENGTH: Readonly<Record<string, number>> = {
  sha1: 40, sha224: 56, sha256: 64, sha384: 96, sha512: 128,
  sha512_224: 56, sha512_256: 64,
  sha3_224: 56, sha3_256: 64, sha3_384: 96, sha3_512: 128,
  md5: 32,
};

/** Cap on reported reasons, so a hostile statement (10,000 bad subjects) cannot flood the response. */
const MAX_STATEMENT_REASONS = 20;

const LOWER_HEX = /^[0-9a-f]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Structurally check an in-toto Statement v1 envelope, LOCALLY: no network, no schema fetch, no
 * dependency. Returns the reasons a consumer's verifier would reject the envelope's shape; an
 * empty array means the shape is conformant.
 *
 * SHAPE ONLY, and deliberately so. It says nothing about whether the subject digest identifies any
 * artifact — this statement's subject digest is the content address of the predicate body, not of a
 * built artifact — nothing about the predicate's own fields (only that it is an object), and
 * nothing about signing. A clean result is NOT a valid attestation of an artifact.
 *
 * Pure and bounded: it reads a fixed set of envelope fields, never recurses into the predicate, and
 * caps the reasons it returns.
 */
export function validateInTotoStatement(s: unknown): string[] {
  const reasons: string[] = [];
  let suppressed = 0;
  const add = (reason: string): void => {
    if (reasons.length < MAX_STATEMENT_REASONS) reasons.push(reason);
    else suppressed++;
  };
  const done = (): string[] => {
    if (suppressed > 0) reasons.push(`… ${suppressed} further problem(s) or unexamined subject(s), not listed (reason cap ${MAX_STATEMENT_REASONS})`);
    return reasons;
  };

  if (!isPlainObject(s)) {
    add(`statement is not a JSON object (got ${Array.isArray(s) ? 'array' : s === null ? 'null' : typeof s})`);
    return done();
  }

  if (!('_type' in s)) add('`_type` is missing');
  else if (typeof s._type !== 'string') add(`\`_type\` is not a string (got ${typeof s._type})`);
  else if (s._type !== IN_TOTO_STATEMENT_TYPE) add(`\`_type\` is not "${IN_TOTO_STATEMENT_TYPE}"`);

  if (!('subject' in s)) add('`subject` is missing');
  else if (!Array.isArray(s.subject)) add(`\`subject\` is not an array (got ${typeof s.subject})`);
  else if (s.subject.length === 0) add('`subject` is an empty array; Statement v1 requires at least one subject');
  else {
    for (const [i, sub] of s.subject.entries()) {
      // Already at the reason cap: stop walking (a 10,000-subject statement is bounded work) and
      // say how many subjects were not examined, rather than reporting silence as cleanliness.
      if (reasons.length >= MAX_STATEMENT_REASONS) { suppressed += s.subject.length - i; break; }
      if (!isPlainObject(sub)) { add(`subject[${i}] is not an object`); continue; }
      if (typeof sub.name !== 'string' || sub.name.length === 0) add(`subject[${i}] has no \`name\` string`);
      if (!isPlainObject(sub.digest)) { add(`subject[${i}] has no \`digest\` object`); continue; }
      const algorithms = Object.keys(sub.digest);
      if (algorithms.length === 0) { add(`subject[${i}].digest is empty; at least one algorithm is required`); continue; }
      for (const alg of algorithms) {
        const value = sub.digest[alg];
        if (typeof value !== 'string') { add(`subject[${i}].digest.${alg} is not a string`); continue; }
        if (!LOWER_HEX.test(value)) { add(`subject[${i}].digest.${alg} is not lowercase hex`); continue; }
        const expected = DIGEST_HEX_LENGTH[alg];
        // An algorithm whose output size this check does not know is left unchecked for length —
        // reporting a guess would be a false rejection.
        if (expected !== undefined && value.length !== expected) {
          add(`subject[${i}].digest.${alg} is ${value.length} hex chars, not ${expected}`);
        }
      }
    }
  }

  if (!('predicateType' in s)) add('`predicateType` is missing');
  else if (typeof s.predicateType !== 'string') add(`\`predicateType\` is not a string (got ${typeof s.predicateType})`);
  else if (s.predicateType.length === 0) add('`predicateType` is empty');

  if (!('predicate' in s)) add('`predicate` is missing');
  else if (!isPlainObject(s.predicate)) add(`\`predicate\` is not a JSON object (got ${Array.isArray(s.predicate) ? 'array' : s.predicate === null ? 'null' : typeof s.predicate})`);

  return done();
}

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
    // The subject names the certified change range; its digest is the content address of THIS
    // predicate (recompute-to-verify), not a file hash — stated so a consumer reads it correctly.
    const statement = {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [{ name: `${cert.resolvedBaseRef}..${cert.change}`, digest: { sha256: digest } }],
      predicateType: PROVENANCE_PREDICATE_TYPE,
      predicate,
    };
    // Every emission is checked against the Statement v1 envelope shape, and the outcome is
    // disclosed either way — never silently. A clean result certifies the ENVELOPE'S SHAPE only.
    const problems = validateInTotoStatement(statement);
    return {
      tool: 'certify_provenance',
      posture: 'advisory',
      statement,
      statementValidation: {
        check: IN_TOTO_STATEMENT_CHECK,
        result: problems.length === 0 ? 'envelope-shape-conformant' : 'envelope-shape-non-conformant',
        scope: 'Structural check of the in-toto Statement v1 envelope only, computed locally (no network, no schema fetch). It does NOT verify a signature, the predicate\'s own fields, or that the subject digest identifies any artifact — so it is not an attestation that an artifact is what it claims to be.',
        ...(problems.length ? { reasons: problems } : {}),
      },
      note: 'An in-toto Statement v1 envelope carrying the change-provenance predicate, unsigned: OpenLore emits but does not sign, and its shape is structurally checked (see statementValidation), not validated against a published schema. The subject digest is the content address of the predicate body, NOT of a built artifact — an in-toto verifier that resolves the subject digest against an artifact will not match it; recompute the predicate to verify.',
    };
  }

  return {
    tool: 'certify_provenance',
    posture: 'advisory',
    predicateType: PROVENANCE_PREDICATE_TYPE,
    digest,
    predicate,
    note: 'Reproducible semantic change provenance. The digest is the content address of the semantic footprint (blast radius + structural delta), not of the diff text, so two edits with the same footprint share a digest. Recompute over the same base to verify. OpenLore emits but does not sign; to attach it to your existing SLSA/in-toto flow, call this tool again with format "in-toto" for the Statement v1 envelope.',
  };
}
