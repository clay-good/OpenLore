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
 *   an explicit class > source default.
 * Most sources default to `advisory`; sources may declare stricter defaults when
 * an invalid artifact would otherwise be trusted. Deterministic, no LLM (north
 * star `c6d1ad07`).
 */

import type {
  EnforcementClass,
  EnforcementConfig,
  BlastRadiusConfig,
  ImpactCertificateConfig,
} from '../../../types/index.js';

/** A repository's declared policy after normalization: a clean `code → class` map. */
export type EnforcementPolicy = Record<string, EnforcementClass>;

/** The four enforcement classes, for runtime validation. */
const ENFORCEMENT_CLASSES: readonly EnforcementClass[] = ['blocking', 'frozen', 'advisory', 'off'];

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
  severity: 'info' | 'warning' | 'error' | 'critical';
  /** Which source produced it (for attribution in gate output). */
  source: string;
  /** The artifact/surface/symbol the finding concerns. */
  subject: string;
  /** Human-readable conclusion. */
  message: string;
  /** Static, source-declared action for this code and subject. */
  remediation?: string;
  /** Stable source-owned discriminator when one code can fire repeatedly for one subject. */
  discriminator?: string;
  /** Grounded source location; line is omitted when the dependency artifact has none. */
  location?: { path: string; line?: number };
  /** Governing decision receipt for decision-bound architecture findings. */
  decision?: {
    id: string;
    title: string;
    rationale: string;
    ruleId: string;
    servedContentMetadata?: { provenance: 'reviewed-corpus' | 'local-unreviewed' };
  };
}

/** A finding paired with the enforcement class the policy resolved for it. */
export interface ClassifiedFinding extends GovernanceFinding {
  enforcementClass: EnforcementClass;
  /** Present when a `frozen` policy was reconciled against its persisted baseline. */
  baselineState?: 'frozen' | 'new';
}

/**
 * The catalogue of stable governance finding codes the policy can name. Every
 * code a source emits MUST be registered here with its source-declared default
 * class, so (a) a declared policy that names an unknown code can be flagged, and
 * (b) the catalogue is the documented contract for what an operator may govern.
 *
 * `defaultClass` is source-owned. Most findings are advisory by default, while
 * corpus resolution and graph-shape failures are blocking because an invalid
 * governance graph must not be trusted as authoritative.
 */
export interface FindingCodeSpec {
  defaultClass: EnforcementClass;
  source: string;
  description: string;
  /** Static template; `{subject}` is replaced literally with the finding subject. */
  remediation?: string;
}

/** Finding codes emitted by the deterministic corpus-intent delta reviewer. */
export const CORPUS_INTENT_FINDING_CODES = [
  'corpus-normative-weakened',
  'corpus-scenario-removed',
  'corpus-requirement-removed',
  'corpus-specificity-lost',
  'corpus-boundary-clause-removed',
  'corpus-decision-status-regressed',
  'corpus-delta-orphaned',
] as const;

export const ARCHITECTURE_FINDING_CODES = [
  'architecture-layer-violation',
  'architecture-forbidden-dependency',
  'architecture-allowed-only-violation',
  'architecture-required-missing',
  'architecture-cycle',
  'architecture-unreachable-breach',
  'architecture-orphan',
  'architecture-instability-inversion',
] as const;

export const FINDING_CODE_REGISTRY: Record<string, FindingCodeSpec> = {
  // ── author-declared architecture rules (widen-architecture-rule-vocabulary) ──
  'architecture-layer-violation': {
    defaultClass: 'advisory', source: 'architecture',
    description: 'A dependency points upward through the declared architecture layers.',
    remediation: 'Layer violation: {subject}; route through the declared interface layer instead of importing directly.',
  },
  'architecture-forbidden-dependency': {
    defaultClass: 'advisory', source: 'architecture',
    description: 'A dependency crosses a path boundary declared forbidden.',
    remediation: 'Forbidden dependency: {subject}; remove the edge or route it through an allowed boundary.',
  },
  'architecture-allowed-only-violation': {
    defaultClass: 'advisory', source: 'architecture',
    description: 'A module depends on a path outside its declared allowlist.',
    remediation: 'Allowlist violation: {subject}; use a declared dependency or update the reviewed architecture rule.',
  },
  'architecture-required-missing': {
    defaultClass: 'advisory', source: 'architecture',
    description: 'A matched module is missing a declared required dependency.',
    remediation: 'Required dependency missing: {subject}; add the declared dependency or revise the reviewed rule.',
  },
  'architecture-cycle': {
    defaultClass: 'advisory', source: 'architecture',
    description: 'Matched modules form a dependency cycle outside the declared exceptions.',
    remediation: 'Architecture cycle: {subject}; break one dependency edge or add a reviewed exception.',
  },
  'architecture-unreachable-breach': {
    defaultClass: 'advisory', source: 'architecture',
    description: 'A file outside the permitted origin transitively reaches the protected target.',
    remediation: 'Reachability breach: {subject}; remove the path or route it through a permitted origin.',
  },
  'architecture-orphan': {
    defaultClass: 'advisory', source: 'architecture',
    description: 'A matched module has no incoming dependency in the indexed graph.',
    remediation: 'Architecture orphan: {subject}; wire it from an intended owner or remove the unused module.',
  },
  'architecture-instability-inversion': {
    defaultClass: 'advisory', source: 'architecture',
    description: 'A stable matched module depends on a strictly more-unstable module.',
    remediation: 'Instability inversion: {subject}; invert the dependency through a stable interface.',
  },
  // ── decision-bound architecture constraints ──
  'decision-constraint-violation': {
    defaultClass: 'advisory',
    source: 'decision-constraint',
    description: 'A dependency violates a machine-checkable rule carried by an authoritative architectural decision.',
  },
  'decision-constraint-malformed': {
    defaultClass: 'advisory',
    source: 'decision-constraint',
    description: 'A decision constraint block is malformed, unsupported, conflicting, or unsafe and was not evaluated.',
  },
  // ── blast-radius guard (add-preflight-blast-radius-guard) ──
  'orphans-anchored-memory': {
    defaultClass: 'advisory',
    source: 'blast-radius',
    description: 'The change orphans one or more code-anchored memories (their anchor symbols are removed).',
    remediation: 'Orphaned memory: {subject}; re-anchor or supersede the affected memory before continuing.',
  },
  'orphans-anchored-decision': {
    defaultClass: 'advisory',
    source: 'blast-radius',
    description: 'The change orphans one or more anchored architectural decisions.',
    remediation: 'Orphaned decision: {subject}; re-anchor or supersede the affected decision before continuing.',
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
  // ── per-edit structural verdict (add-edit-loop-breakage-verdict) ──
  'edit-broken-reference': {
    defaultClass: 'advisory',
    source: 'edit-verdict',
    description: 'An edited file removed or renamed a symbol that still has a resolved call site.',
  },
  'edit-arity-mismatch': {
    defaultClass: 'advisory',
    source: 'edit-verdict',
    description: 'An edited signature is provably incompatible with a stored call-site argument count.',
  },
  'edit-import-breakage': {
    defaultClass: 'advisory',
    source: 'edit-verdict',
    description: 'An edited file no longer exports a name that another file still imports.',
  },
  // ── parse-health (add-parse-health-boundary-disclosure) ──
  'parse-health': {
    defaultClass: 'advisory',
    source: 'parse-health',
    description: 'One or more indexed files parsed with errors (tree-sitter ERROR/MISSING regions, a swallowed parse failure, or a lossy encoding decode) — the graph there is a lower bound. An operator can gate on a regression (e.g. a grammar bump that suddenly errors many files).',
  },
  // ── stale-decision-reference (add-finding-enforcement-policy) ──
  'stale-decision-reference': {
    defaultClass: 'advisory',
    source: 'stale-decision-reference',
    description: 'A live, authoritative artifact references a decision that has since been superseded/retired.',
    remediation: 'Stale decision reference: {subject}; point it at the authoritative superseding decision.',
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
  // ── conclusion-over-graph contract (enforce-conclusion-contract-runtime) ──
  'conclusion-shape-violation': {
    defaultClass: 'advisory',
    source: 'conclusion-contract',
    description: 'A conclusion-classified tool returned a graph-shaped response at runtime (a top-level nodes[]+edges[] join, or a raw id-reference edge dump over MAX_PROVENANCE_EDGES) instead of the computed conclusion — pushing the traversal back onto the agent. Advisory by default: the result is still returned with this disclosure attached. Gate on it via enforcement.policy to fail CI when a handler regresses.',
  },
  // ── served-content trust boundary (bound-served-content-trust) ──
  'injection-shaped-content': {
    defaultClass: 'advisory',
    source: 'doctor',
    description: 'Unreviewed served content lexically resembles an imperative override, message impersonation, or direction away from a recorded decision. The check is incomplete and review-only.',
  },
  // ── governance corpus integrity (add-knowledge-corpus-integrity) ──
  'corpus-reference-unresolved': {
    defaultClass: 'blocking',
    source: 'corpus-integrity',
    description: 'A declared corpus edge names a target that cannot be resolved.',
  },
  'corpus-reference-ambiguous': {
    defaultClass: 'blocking',
    source: 'corpus-integrity',
    description: 'A declared corpus edge resolves to more than one target.',
  },
  'corpus-self-reference': {
    defaultClass: 'blocking',
    source: 'corpus-integrity',
    description: 'A corpus artifact declares a graph edge to itself where self-reference is invalid.',
  },
  'corpus-duplicate-identifier': {
    defaultClass: 'blocking',
    source: 'corpus-integrity',
    description: 'Multiple corpus artifacts declare the same identifier.',
  },
  'corpus-edge-unsupported': {
    defaultClass: 'blocking',
    source: 'corpus-integrity',
    description: 'A corpus artifact declares an edge kind that its artifact type does not support.',
  },
  'corpus-target-type-mismatch': {
    defaultClass: 'blocking',
    source: 'corpus-integrity',
    description: 'A declared corpus edge resolves to an artifact outside the edge\'s target range.',
  },
  'corpus-target-retired': {
    defaultClass: 'advisory',
    source: 'corpus-integrity',
    description: 'A live corpus artifact references a superseded, rejected, or otherwise retired target.',
  },
  'corpus-supersession-cycle': {
    defaultClass: 'blocking',
    source: 'corpus-integrity',
    description: 'Decision supersession edges form a cycle, so no member can be treated as authoritative.',
  },
  'corpus-anchor-target-missing': {
    defaultClass: 'advisory',
    source: 'corpus-integrity',
    description: 'A corpus artifact anchor names a symbol or file that no longer exists.',
  },
  'corpus-reference-undeclared': {
    defaultClass: 'advisory',
    source: 'corpus-integrity',
    description: 'Corpus prose names another artifact without declaring the corresponding graph edge.',
  },
  // ── corpus intent delta review (add-corpus-change-intent-review) ──
  'corpus-normative-weakened': {
    defaultClass: 'advisory',
    source: 'corpus-intent-review',
    description: 'A requirement uses a weaker normative keyword than it did in the compared base corpus.',
  },
  'corpus-scenario-removed': {
    defaultClass: 'advisory',
    source: 'corpus-intent-review',
    description: 'A requirement has fewer acceptance scenarios than it did in the compared base corpus.',
  },
  'corpus-requirement-removed': {
    defaultClass: 'advisory',
    source: 'corpus-intent-review',
    description: 'A base requirement has no exact-name or identical-scenario successor in the compared head corpus.',
  },
  'corpus-specificity-lost': {
    defaultClass: 'advisory',
    source: 'corpus-intent-review',
    description: 'A measurable clause from a requirement is absent from the compared head corpus.',
  },
  'corpus-boundary-clause-removed': {
    defaultClass: 'advisory',
    source: 'corpus-intent-review',
    description: 'A disclosed-boundary or honesty clause was removed from the compared head corpus.',
  },
  'corpus-decision-status-regressed': {
    defaultClass: 'advisory',
    source: 'corpus-intent-review',
    description: 'A decision moved from an authoritative status to a weaker status without a recorded superseder.',
  },
  'corpus-delta-orphaned': {
    defaultClass: 'advisory',
    source: 'corpus-intent-review',
    description: 'An active change delta targets a requirement that disappeared from the compared corpus.',
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
 *   explicit class > source default.
 * Order-independent and total. Exposed separately so the precedence is unit-tested
 * directly, including a source default of `blocking` (which no current code uses).
 */
export function applyPolicyPrecedence(
  explicit: EnforcementClass | undefined,
  sourceDefault: EnforcementClass,
): EnforcementClass {
  if (explicit === 'off') return 'off';
  if (explicit === 'blocking') return 'blocking';
  if (explicit === 'frozen') return 'frozen';
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
  return [f.code, f.subject, f.discriminator ?? '', f.source, f.severity, f.message].join('\0');
}

export interface GateResult {
  /** Every finding with its resolved class, sorted by a stable key. */
  classified: ClassifiedFinding[];
  blocking: ClassifiedFinding[];
  advisory: ClassifiedFinding[];
  /** Findings protected by a persisted frozen baseline. */
  frozen: ClassifiedFinding[];
  /** Deliberately silenced findings — listed as informational, never failing. */
  off: ClassifiedFinding[];
  /** True when an explicit blocking finding or a frozen-baseline condition fails the gate. */
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
  const unique = new Map<string, ClassifiedFinding>();
  for (const finding of findings) {
    const template = FINDING_CODE_REGISTRY[finding.code]?.remediation;
    const classified = {
      ...finding,
      ...(finding.remediation ? {} : template ? { remediation: template.replaceAll('{subject}', () => finding.subject) } : {}),
      enforcementClass: resolveEnforcementClass(finding.code, policy, finding.severity),
    };
    const key = findingKey(classified);
    if (!unique.has(key)) unique.set(key, classified);
  }
  const classified = [...unique.values()].sort((a, b) => stableCompare(findingKey(a), findingKey(b)));
  const blocking = classified.filter((f) => f.enforcementClass === 'blocking');
  const advisory = classified.filter((f) => f.enforcementClass === 'advisory');
  const frozen = classified.filter((f) => f.enforcementClass === 'frozen');
  const off = classified.filter((f) => f.enforcementClass === 'off');
  return { classified, blocking, advisory, frozen, off, gated: blocking.length > 0 };
}
