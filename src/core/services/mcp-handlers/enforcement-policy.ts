/**
 * Unified finding-enforcement policy (change: add-finding-enforcement-policy).
 *
 * OpenLore emits governance findings from several deterministic sources — the
 * pre-flight blast-radius guard, the change-impact certificate, and (this change)
 * the stale-decision-reference check. Each had grown its OWN config for "should
 * this block a commit or merely inform?" (`blastRadius.block`,
 * `impactCertificate.block`), so an operator had to learn N enforcement stories.
 *
 * This module is the single source of truth. It decouples two things that should
 * be separate:
 *   - a finding's *intrinsic severity* — a property of the finding, owned by the
 *     source that computes it (never altered here);
 *   - its *enforcement class* — whether THIS repository wants it to block, owned
 *     by `.openlore/config.json` `enforcement.policy` (a `code → class` map).
 *
 * Resolution is a pure, order-independent function with a fixed precedence:
 *   explicit `off` > explicit `blocking` > explicit `advisory` > source default.
 * `advisory` is the source default for every code, so a repository that declares
 * no policy behaves exactly as it does today. Deterministic, no LLM (north star
 * `c6d1ad07`).
 */

import type {
  EnforcementClass,
  EnforcementConfig,
  BlastRadiusConfig,
  ImpactCertificateConfig,
} from '../../../types/index.js';

/** A repository's declared policy after normalization: a clean `code → class` map. */
export type EnforcementPolicy = Record<string, EnforcementClass>;

/** The three enforcement classes, for runtime validation. */
const ENFORCEMENT_CLASSES: readonly EnforcementClass[] = ['blocking', 'advisory', 'off'];

function isEnforcementClass(v: unknown): v is EnforcementClass {
  return typeof v === 'string' && (ENFORCEMENT_CLASSES as readonly string[]).includes(v);
}

/**
 * A governance finding in the shape the policy can govern: a stable `code`, an
 * intrinsic `severity` (owned by the source — informational here, never used to
 * decide the class), and enough context to render it. Every finding source maps
 * its native finding onto this shape before the gate classifies it.
 */
export interface GovernanceFinding {
  /** Stable, documented code — the key a declared policy names. */
  code: string;
  /** The emitting source's intrinsic severity. Never altered by the policy. */
  severity: string;
  /** Which source produced it (for attribution in gate output). */
  source: string;
  /** The artifact/surface/symbol the finding concerns. */
  subject: string;
  /** Human-readable conclusion. */
  message: string;
}

/** A finding paired with the enforcement class the policy resolved for it. */
export interface ClassifiedFinding extends GovernanceFinding {
  enforcementClass: EnforcementClass;
}

/**
 * The catalogue of stable governance finding codes the policy can name. Every
 * code a source emits MUST be registered here with its source-declared default
 * class, so (a) a declared policy that names an unknown code can be flagged, and
 * (b) the catalogue is the documented contract for what an operator may govern.
 *
 * `defaultClass` is `advisory` for every code: blocking is always opt-in, per
 * `add-preflight-blast-radius-guard`/AdvisoryByDefault. The field exists so a
 * future source CAN declare a stricter default without changing the resolver.
 */
export interface FindingCodeSpec {
  defaultClass: EnforcementClass;
  source: string;
  description: string;
}

export const FINDING_CODE_REGISTRY: Record<string, FindingCodeSpec> = {
  // ── blast-radius guard (add-preflight-blast-radius-guard) ──
  'orphans-anchored-memory': {
    defaultClass: 'advisory',
    source: 'blast-radius',
    description: 'The change orphans one or more code-anchored memories (their anchor symbols are removed).',
  },
  'orphans-anchored-decision': {
    defaultClass: 'advisory',
    source: 'blast-radius',
    description: 'The change orphans one or more anchored architectural decisions.',
  },
  // ── change-impact certificate (add-change-impact-certificate) ──
  // Per-severity codes so `impactCertificate.block` lowers onto the policy exactly.
  'surface-info': {
    defaultClass: 'advisory',
    source: 'impact-certificate',
    description: 'The change opens a new path into a declared covering surface marked `info`.',
  },
  'surface-warn': {
    defaultClass: 'advisory',
    source: 'impact-certificate',
    description: 'The change opens a new path into a declared covering surface marked `warn`.',
  },
  'surface-critical': {
    defaultClass: 'advisory',
    source: 'impact-certificate',
    description: 'The change opens a new path into a declared covering surface marked `critical`.',
  },
  // ── stale-decision-reference (add-finding-enforcement-policy) ──
  'stale-decision-reference': {
    defaultClass: 'advisory',
    source: 'stale-decision-reference',
    description: 'A live, authoritative artifact references a decision that has since been superseded/retired.',
  },
  // ── footprint escape detection (add-footprint-escape-detection) ──
  'footprint-escape': {
    defaultClass: 'advisory',
    source: 'footprint-escape',
    description: 'A diff modified a symbol outside the task\'s declared write-footprint (out-of-scope write, read-set intrusion, or scope creep within a declared file).',
  },
  'footprint-escape-new-conflict': {
    defaultClass: 'advisory',
    source: 'footprint-escape',
    description: 'An out-of-scope write landed in a peer task\'s declared write-set, opening a new write-write conflict the swarm plan did not have.',
  },
  'mis-declared-append': {
    defaultClass: 'advisory',
    source: 'footprint-escape',
    description: 'A write declared `append` at plan time actually modified existing code (refuting the plan-time shared-append optimism).',
  },
  // ── plan_parallel_work (add-parallel-work-plan) ──
  'parallel-work-conflict': {
    defaultClass: 'advisory',
    source: 'plan-parallel-work',
    description: 'Two tasks proposed for concurrent work have a write-write (WAW) conflict; the plan schedules them into different waves.',
  },
  'parallel-work-cycle': {
    defaultClass: 'advisory',
    source: 'plan-parallel-work',
    description: 'A set of proposed tasks forms an unorderable read-after-write cycle; no wave order satisfies all dependencies, so the members are scheduled mutually exclusive and the circular dependency should be resolved.',
  },
  // ── cross-actor interference map (add-cross-actor-interference-map) ──
  'cross-actor-conflict': {
    defaultClass: 'advisory',
    source: 'interference-map',
    description: 'Two in-flight changes (branches/PRs/agent tasks, within or across a federation) have a write-write (WAW) conflict on a shared symbol; they must not land concurrently. A CI check can name this code to warn when a new PR collides with an open one.',
  },
};

/** Whether a code is registered (so a declared policy entry is recognized). */
export function isKnownFindingCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(FINDING_CODE_REGISTRY, code);
}

/** The source-declared default class for a code (`advisory` if unregistered). */
export function sourceDefaultClass(code: string): EnforcementClass {
  return FINDING_CODE_REGISTRY[code]?.defaultClass ?? 'advisory';
}

/**
 * The pure precedence core. Given the policy's explicit class for a code (if any)
 * and the source-declared default, pick the effective class:
 *   explicit `off` > explicit `blocking` > explicit `advisory` > source default.
 * Order-independent and total. Exposed separately so the precedence is unit-tested
 * directly, including a source default of `blocking` (which no current code uses).
 */
export function applyPolicyPrecedence(
  explicit: EnforcementClass | undefined,
  sourceDefault: EnforcementClass,
): EnforcementClass {
  if (explicit === 'off') return 'off';
  if (explicit === 'blocking') return 'blocking';
  if (explicit === 'advisory') return 'advisory';
  return sourceDefault;
}

/**
 * Resolve the enforcement class for a finding. Pure function of the finding's
 * `code`, the declared `policy`, and its intrinsic `severity`. The severity is
 * NOT used to decide the class (the policy owns enforcement, the source owns
 * severity) — it is part of the signature so the contract is explicit and a
 * future severity-aware default is expressible without a signature change.
 * Identical inputs produce identical output regardless of policy declaration order.
 */
export function resolveEnforcementClass(
  code: string,
  policy: EnforcementPolicy | undefined,
  _severity?: string,
): EnforcementClass {
  return applyPolicyPrecedence(policy?.[code], sourceDefaultClass(code));
}

/**
 * Normalize a raw `enforcement` config block into a clean policy map. Tolerant by
 * design (config is untrusted): a non-object block, non-object `policy`, or any
 * entry whose value is not a valid class is dropped. Never throws — a malformed
 * policy degrades to "no policy declared," preserving current behavior. Unknown
 * codes are RETAINED (a policy may name a code before its source ships); use
 * {@link unknownPolicyCodes} to surface them as non-failing findings.
 */
export function normalizeEnforcementPolicy(raw: EnforcementConfig | undefined): EnforcementPolicy {
  const policy: EnforcementPolicy = {};
  const entries = raw?.policy;
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return policy;
  for (const [code, cls] of Object.entries(entries)) {
    if (typeof code === 'string' && code.length > 0 && isEnforcementClass(cls)) policy[code] = cls;
  }
  return policy;
}

/** Codes named by a declared policy that no installed source emits (sorted, stable). */
export function unknownPolicyCodes(policy: EnforcementPolicy): string[] {
  return Object.keys(policy).filter((code) => !isKnownFindingCode(code)).sort();
}

/**
 * Lower the legacy per-surface `block: [...]` configs onto unified policy entries,
 * so a `blastRadius.block` / `impactCertificate.block` declaration resolves
 * identically to the equivalent `enforcement.policy`. The legacy sugar is a thin
 * equivalent of, and is superseded by, the unified policy. Returns only the
 * lowered entries; callers merge them UNDER an explicit `enforcement.policy` so a
 * direct policy entry always wins over inherited legacy sugar.
 */
export function lowerLegacyBlockConfig(config: {
  blastRadius?: BlastRadiusConfig;
  impactCertificate?: ImpactCertificateConfig;
} | null | undefined): EnforcementPolicy {
  const lowered: EnforcementPolicy = {};
  const blast = config?.blastRadius?.block;
  if (Array.isArray(blast)) {
    for (const pattern of blast) {
      if (typeof pattern === 'string' && isKnownFindingCode(pattern)) lowered[pattern] = 'blocking';
    }
  }
  const cert = config?.impactCertificate?.block;
  if (Array.isArray(cert)) {
    for (const sev of cert) {
      if (sev === 'info' || sev === 'warn' || sev === 'critical') lowered[`surface-${sev}`] = 'blocking';
    }
  }
  return lowered;
}

/**
 * Build the effective policy a gate consults: the lowered legacy `block` sugar
 * with an explicit `enforcement.policy` layered ON TOP (a direct policy entry
 * always wins). Both inputs are normalized/tolerant — a malformed config yields an
 * empty policy, never a throw.
 */
export function effectivePolicy(config: {
  enforcement?: EnforcementConfig;
  blastRadius?: BlastRadiusConfig;
  impactCertificate?: ImpactCertificateConfig;
} | null | undefined): EnforcementPolicy {
  return { ...lowerLegacyBlockConfig(config), ...normalizeEnforcementPolicy(config?.enforcement) };
}

/** Locale-independent, byte-stable string compare so gate output is reproducible across environments. */
function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A stable sort key so identical findings produce identical, reproducible gate output. */
function findingKey(f: GovernanceFinding): string {
  return `${f.code} ${f.subject} ${f.message}`;
}

export interface GateResult {
  /** Every finding with its resolved class, sorted by a stable key. */
  classified: ClassifiedFinding[];
  blocking: ClassifiedFinding[];
  advisory: ClassifiedFinding[];
  /** Deliberately silenced findings — listed as informational, never failing. */
  off: ClassifiedFinding[];
  /** True iff at least one finding resolved to `blocking`. */
  gated: boolean;
}

/**
 * Classify every finding through the policy and partition by class. The gate fails
 * (`gated`) only when at least one finding resolves to `blocking`. Findings are
 * sorted by a stable key so identical inputs produce identical output. Pure — no
 * I/O, no LLM.
 */
export function classifyFindings(
  findings: readonly GovernanceFinding[],
  policy: EnforcementPolicy | undefined,
): GateResult {
  const classified: ClassifiedFinding[] = findings
    .map((f) => ({ ...f, enforcementClass: resolveEnforcementClass(f.code, policy, f.severity) }))
    .sort((a, b) => stableCompare(findingKey(a), findingKey(b)));
  const blocking = classified.filter((f) => f.enforcementClass === 'blocking');
  const advisory = classified.filter((f) => f.enforcementClass === 'advisory');
  const off = classified.filter((f) => f.enforcementClass === 'off');
  return { classified, blocking, advisory, off, gated: blocking.length > 0 };
}
