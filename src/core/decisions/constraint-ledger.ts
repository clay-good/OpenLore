/**
 * Decision-bound architecture constraints and their eligibility ledger
 * (change: add-decision-bound-code-constraints).
 *
 * Classification is author-declared only. This module parses persisted bytes,
 * joins them to the decision lifecycle, and lowers valid rules into the existing
 * architecture vocabulary. It never calls an LLM, an embedder, or the network.
 */

import type {
  DecisionConstraintBlock,
  DecisionConstraintEligibility,
  PendingDecision,
} from '../../types/index.js';
import type { GovernanceFinding } from '../services/mcp-handlers/enforcement-policy.js';
import {
  parseArchitectureRules,
  type ArchitectureRule,
  type ArchitectureRules,
} from '../architecture/rules.js';
import { scanViolations } from '../architecture/check.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import { loadDurableDecisionProjections } from './corpus-integrity.js';
import { loadDecisionStore } from './store.js';
import { decisionContentProvenance, reviewedFileContentProvenance } from '../services/served-content.js';

const MARKER_LABEL = '> OpenLore constraints: ';
const MAX_MARKER_BYTES = 131_072;
const MAX_POLICY_TEXT = 4_096;
const MAX_RULE_PATHS = 256;

export interface PersistedConstraintPayload {
  decisionId: string;
  title: string;
  rationale: string;
  supersedes?: string;
  constraints: DecisionConstraintBlock;
}

export interface RetiredDecisionRule {
  decisionId: string;
  decisionTitle: string;
  ruleId: string;
  status: PendingDecision['status'] | 'superseded';
}

export interface EligibilityDecisionReceipt {
  decisionId: string;
  title: string;
  status: DecisionConstraintEligibility['status'];
  constrained: boolean;
  reason?: string;
  enforcedBoundary?: string;
  humanReviewRemainder?: string;
  servedContentMetadata: { provenance: 'reviewed-corpus' | 'local-unreviewed' };
}

export interface EnforcementEligibilityLedger {
  adoption: { constrained: number; authoritative: number; ratio: number | null };
  coverage: { constrainedEligible: number; eligible: number; ratio: number | null };
  unclassifiedCount: number;
  activeRuleCount: number;
  coverageGaps: Array<{ decisionId: string; title: string }>;
  decisions: EligibilityDecisionReceipt[];
}

export interface DecisionConstraintState extends ArchitectureRules {
  malformedFindings: GovernanceFinding[];
  retiredRules: RetiredDecisionRule[];
  ledger: EnforcementEligibilityLedger;
  violationAssessmentComplete: boolean;
}

interface CorpusDecision {
  decision: PendingDecision;
  constraints?: DecisionConstraintBlock;
  markerErrors?: string[];
  provenance: 'reviewed-corpus' | 'local-unreviewed';
  authorityConflict?: boolean;
}

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Measure JSON without first allocating a complete serialized copy. */
function boundedJsonBytes(value: unknown, limit: number): number | null {
  let bytes = 0;
  const active = new Set<object>();
  const add = (count: number): boolean => (bytes += count) <= limit;
  const stringBytes = (value: string): boolean => {
    if (!add(2)) return false;
    for (const character of value) {
      const code = character.codePointAt(0)!;
      const escaped = character === '"' || character === '\\' || code < 0x20;
      if (!add(escaped ? (code < 0x20 ? 6 : 2) : Buffer.byteLength(character, 'utf8'))) return false;
    }
    return true;
  };
  const visit = (current: unknown): boolean => {
    if (current === null) return add(4);
    if (typeof current === 'string') return stringBytes(current);
    if (typeof current === 'boolean') return add(current ? 4 : 5);
    if (typeof current === 'number') return Number.isFinite(current) && add(String(current).length);
    if (typeof current !== 'object' || active.has(current)) return false;
    active.add(current);
    let ok: boolean;
    if (Array.isArray(current)) {
      ok = add(1);
      for (let index = 0; ok && index < current.length; index++) {
        if (index > 0) ok = add(1);
        if (ok) ok = visit(current[index]);
      }
      if (ok) ok = add(1);
    } else {
      ok = add(1);
      let index = 0;
      for (const [key, nested] of Object.entries(current)) {
        if (!ok) break;
        if (index++ > 0) ok = add(1);
        if (ok) ok = stringBytes(key) && add(1) && visit(nested);
      }
      if (ok) ok = add(1);
    }
    active.delete(current);
    return ok;
  };
  return visit(value) ? bytes : null;
}

function markerOccupiesGeneratedSlot(projection: { path: string; text: string }, decisionId: string): boolean {
  const escapedId = decisionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/(?:^|\/)decisions\/[^/]+\.md$/i.test(projection.path)) {
    return new RegExp(
      `^> Recorded by openlore decisions[^\\n]*\\n> Decision ID:\\s*${escapedId}\\s*\\n(?:> Supersedes:[^\\n]*\\n)?` +
      '> OpenLore constraints:\\s*[^\\n]+\\n?\\s*$',
    ).test(projectionConstraintText(projection));
  }
  return new RegExp(
    `^###\\s+[^\\n]+\\n\\s*\\n\\*\\*Status:\\*\\*[^\\n]+\\n` +
    '(?:\\*\\*Date:\\*\\*[^\\n]+\\n)?' +
    `\\*\\*ID:\\*\\*\\s*${escapedId}\\s*\\n(?:\\*\\*Supersedes:\\*\\*[^\\n]*\\n)?` +
    '> OpenLore constraints:\\s*[^\\n]+$',
    'm',
  ).test(projection.text);
}

function projectionConstraintText(projection: { path: string; text: string }): string {
  if (!/(?:^|\/)decisions\/[^/]+\.md$/i.test(projection.path)) return projection.text;
  const marker = '> Recorded by openlore decisions';
  const index = projection.text.lastIndexOf(marker);
  return index >= 0 ? projection.text.slice(index) : '';
}

function jsonForMarker(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

function canonicalConstraintBlock(block: DecisionConstraintBlock): DecisionConstraintBlock {
  const eligibility = block.eligibility?.status === 'eligible'
    ? {
        status: 'eligible' as const,
        enforcedBoundary: block.eligibility.enforcedBoundary,
        ...(block.eligibility.humanReviewRemainder
          ? { humanReviewRemainder: block.eligibility.humanReviewRemainder }
          : {}),
      }
    : block.eligibility?.status === 'ineligible'
      ? { status: 'ineligible' as const, reason: block.eligibility.reason }
      : block.eligibility?.status === 'unclassified'
        ? { status: 'unclassified' as const }
        : undefined;
  const rules = [...block.rules]
    .sort((a, b) => stableCompare(a.id, b.id))
    .map((rule) => rule.kind === 'layers'
      ? { id: rule.id, scope: rule.scope, kind: rule.kind, layers: rule.layers, ...(rule.reason ? { reason: rule.reason } : {}) }
      : rule.kind === 'forbidden'
        ? { id: rule.id, scope: rule.scope, kind: rule.kind, from: rule.from, to: rule.to, ...(rule.reason ? { reason: rule.reason } : {}) }
        : { id: rule.id, scope: rule.scope, kind: rule.kind, module: rule.module, mayDependOn: rule.mayDependOn, ...(rule.reason ? { reason: rule.reason } : {}) });
  return { version: block.version, ...(eligibility ? { eligibility } : {}), rules };
}

function canonicalPayload(payload: PersistedConstraintPayload): PersistedConstraintPayload {
  return {
    decisionId: payload.decisionId,
    title: payload.title,
    rationale: payload.rationale,
    ...(payload.supersedes ? { supersedes: payload.supersedes } : {}),
    constraints: canonicalConstraintBlock(payload.constraints),
  };
}

/** Machine-readable, deterministic durable projection used by specs and ADRs. */
export function renderDecisionConstraintMarker(decision: PendingDecision): string {
  if (!decision.constraints) return '';
  const payload: PersistedConstraintPayload = {
    decisionId: decision.id,
    title: decision.title,
    rationale: decision.rationale,
    ...(decision.supersedes ? { supersedes: decision.supersedes } : {}),
    constraints: canonicalConstraintBlock(decision.constraints),
  };
  return `${MARKER_LABEL}${jsonForMarker(payload)}`;
}

/** Parse only explicitly-labelled markers; malformed JSON remains caller-visible. */
export function parseDecisionConstraintMarkers(text: string): Array<{
  payload?: PersistedConstraintPayload;
  error?: string;
}> {
  const parsed: Array<{ payload?: PersistedConstraintPayload; error?: string }> = [];
  // A marker is trusted only when it is immediately adjacent to the generated
  // stable-id line (and optional generated Supersedes line). Marker-looking text
  // in rationale, code fences, comments, or another decision cannot bind a rule.
  let inFence: { character: string; length: number } | null = null;
  let inComment = false;
  const structuralText = text.split(/\r?\n/).map((line) => {
    const markdownContent = line.replace(/^\s*>\s?/, '');
    if (inComment) {
      if (markdownContent.includes('-->')) inComment = false;
      return '\0';
    }
    if (markdownContent.includes('<!--')) {
      if (!markdownContent.includes('-->') || markdownContent.indexOf('<!--') > markdownContent.indexOf('-->')) inComment = true;
      return '\0';
    }
    const fence = markdownContent.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (inFence === null) inFence = { character: fence[1][0], length: fence[1].length };
      else if (fence[1][0] === inFence.character
        && fence[1].length >= inFence.length
        && fence[2].trim() === '') inFence = null;
      return '\0';
    }
    return inFence === null ? line : '\0';
  }).join('\n');
  const patterns = [
    /^\*\*ID:\*\*\s*([0-9a-f]{8})\s*\n(?:\*\*Supersedes:\*\*[^\n]*\n)?(> OpenLore constraints: (.+))$/gm,
    /^> Decision ID:\s*([0-9a-f]{8})\s*\n(?:> Supersedes:[^\n]*\n)?(> OpenLore constraints: (.+))$/gm,
  ];
  for (const pattern of patterns) for (const match of structuralText.matchAll(pattern)) {
    try {
      if (Buffer.byteLength(match[3], 'utf8') > MAX_MARKER_BYTES) {
        parsed.push({ error: `constraint marker exceeds ${MAX_MARKER_BYTES} bytes` });
        continue;
      }
      const value = JSON.parse(match[3]) as unknown;
      if (!value || typeof value !== 'object') {
        parsed.push({ error: 'constraint marker payload must be a JSON object' });
      } else {
        const payload = value as Record<string, unknown>;
        const payloadKeys = Object.keys(payload);
        const metadataValid = typeof payload.decisionId === 'string'
          && typeof payload.title === 'string' && payload.title.length <= MAX_POLICY_TEXT
          && typeof payload.rationale === 'string' && payload.rationale.length <= MAX_POLICY_TEXT
          && (payload.supersedes === undefined || (typeof payload.supersedes === 'string' && /^[0-9a-f]{8}$/.test(payload.supersedes)))
          && payload.constraints !== null
          && typeof payload.constraints === 'object'
          && !Array.isArray(payload.constraints)
          && payloadKeys.every((key) => ['decisionId', 'title', 'rationale', 'supersedes', 'constraints'].includes(key));
        if (!metadataValid) {
          parsed.push({ error: 'constraint marker has invalid decision metadata or constraint block' });
        } else {
          parsed.push(payload.decisionId === match[1]
            ? { payload: payload as unknown as PersistedConstraintPayload }
            : { error: `constraint marker decisionId ${JSON.stringify(payload.decisionId)} does not match adjacent decision ${match[1]}` });
        }
      }
    } catch (error) {
      parsed.push({ error: `constraint marker contains invalid JSON: ${(error as Error).message}` });
    }
  }
  return parsed;
}

function isAuthoritative(status: PendingDecision['status']): boolean {
  // Autopilot prose is explicitly unreviewed and cannot gain enforcement power.
  return status === 'approved' || status === 'synced';
}

function validPathPrefix(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value.includes('\\')) return false;
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) return false;
  if (value.includes('*') || value.includes('?') || value.includes('[') || value.includes(']')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.replace(/\/+$/, '').split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function malformed(
  decision: PendingDecision,
  discriminator: string,
  detail: string,
): GovernanceFinding {
  return {
    code: 'decision-constraint-malformed',
    severity: 'error',
    source: 'decision-constraint',
    subject: `decision:${decision.id}`,
    discriminator,
    message: `Decision ${decision.id} (${decision.title}) has a malformed constraint block: ${detail}`,
  };
}

function parseOneRule(
  decision: PendingDecision,
  raw: unknown,
  index: number,
  provenance: 'reviewed-corpus' | 'local-unreviewed',
): { rule?: ArchitectureRule; findings: GovernanceFinding[]; id?: string } {
  const findings: GovernanceFinding[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { findings: [malformed(decision, `rule:${index}`, `rules[${index}] must be an object`)] };
  }
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === 'string' ? value.id : undefined;
  if (!id || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    findings.push(malformed(decision, `rule:${index}:id`, `rules[${index}].id must be a stable non-empty identifier`));
  }
  if (!validPathPrefix(value.scope)) {
    findings.push(malformed(decision, `rule:${id ?? index}:scope`, `rules[${index}].scope must be a confined repository-relative path prefix`));
  }
  const kind = value.kind;
  if (kind !== 'layers' && kind !== 'forbidden' && kind !== 'allowedOnly') {
    findings.push(malformed(decision, `rule:${id ?? index}:kind`, `rules[${index}].kind is not in the existing architecture rule vocabulary`));
  }
  const commonKeys = new Set(['id', 'scope', 'kind', 'reason']);
  const kindKeys = kind === 'layers' ? ['layers']
    : kind === 'forbidden' ? ['from', 'to']
      : kind === 'allowedOnly' ? ['module', 'mayDependOn'] : [];
  for (const key of Object.keys(value)) {
    if (!commonKeys.has(key) && !kindKeys.includes(key)) {
      findings.push(malformed(decision, `rule:${id ?? index}:unknown-key`, `rules[${index}] contains unknown field ${JSON.stringify(key)}`));
    }
  }
  if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > MAX_POLICY_TEXT)) {
    findings.push(malformed(decision, `rule:${id ?? index}:reason`, `rules[${index}].reason must be a bounded string`));
  }
  if (kind === 'allowedOnly' && (!Array.isArray(value.mayDependOn) || value.mayDependOn.length > MAX_RULE_PATHS)) {
    findings.push(malformed(decision, `rule:${id ?? index}:paths`, `rules[${index}].mayDependOn must contain at most ${MAX_RULE_PATHS} paths`));
  }
  if (kind === 'layers') {
    const layers = value.layers;
    if (!layers || typeof layers !== 'object' || Array.isArray(layers)
      || Object.keys(layers).length > MAX_RULE_PATHS
      || Object.keys(layers).some((name) => name.length === 0 || name.length > 128)
      || Object.values(layers).some((paths) => !Array.isArray(paths) || paths.length > MAX_RULE_PATHS)) {
      findings.push(malformed(decision, `rule:${id ?? index}:layers`, `rules[${index}].layers exceeds the bounded layer/path shape`));
    }
  }
  const paths = kind === 'forbidden' ? [value.from, value.to]
    : kind === 'allowedOnly' && Array.isArray(value.mayDependOn) && value.mayDependOn.length <= MAX_RULE_PATHS
      ? [value.module, ...value.mayDependOn]
      : kind === 'layers' && value.layers && typeof value.layers === 'object' && !Array.isArray(value.layers)
        && Object.keys(value.layers).length <= MAX_RULE_PATHS
        && Object.values(value.layers).every((entry) => Array.isArray(entry) && entry.length <= MAX_RULE_PATHS)
          ? Object.values(value.layers as Record<string, unknown>).flatMap((entry) => entry as unknown[])
          : [];
  if (paths.some((path) => !validPathPrefix(path))) {
    findings.push(malformed(decision, `rule:${id ?? index}:path`, `rules[${index}] contains an invalid repository-relative rule path`));
  }
  if (findings.length > 0) return { findings, id };

  const parsed = parseArchitectureRules(
    kind === 'layers'
      ? { layers: value.layers }
      : kind === 'forbidden'
        ? { forbidden: [{ from: value.from, to: value.to, reason: value.reason }] }
        : { allowedOnly: [{ module: value.module, mayDependOn: value.mayDependOn, reason: value.reason }] },
    'decision',
  );
  if (parsed.rules.length !== 1 || parsed.warnings.length > 0) {
    findings.push(malformed(
      decision,
      `rule:${id}:shape`,
      parsed.warnings.join('; ') || `rules[${index}] does not define one valid ${String(kind)} rule`,
    ));
    return { findings, id };
  }
  const rule = parsed.rules[0];
  return {
    id,
    findings,
    rule: {
      ...rule,
      ruleId: id!,
      scope: value.scope as string,
      decision: {
        id: decision.id,
        title: decision.title,
        rationale: decision.rationale,
        servedContentMetadata: {
          provenance,
        },
      },
    },
  };
}

function validateBlock(
  decision: PendingDecision,
  block: unknown,
  provenance = decisionContentProvenance(decision) as 'reviewed-corpus' | 'local-unreviewed',
): { rules: ArchitectureRule[]; eligibility: DecisionConstraintEligibility; findings: GovernanceFinding[] } {
  const findings: GovernanceFinding[] = [];
  const unclassified: DecisionConstraintEligibility = { status: 'unclassified' };
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return { rules: [], eligibility: unclassified, findings: [malformed(decision, 'block', 'expected an object')] };
  }
  const serializedBytes = boundedJsonBytes(block, MAX_MARKER_BYTES);
  if (serializedBytes === null) {
    return {
      rules: [],
      eligibility: unclassified,
      findings: [malformed(decision, 'block:serialization', `constraint block must be finite JSON data no larger than ${MAX_MARKER_BYTES} bytes`)],
    };
  }
  const raw = block as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== 'version' && key !== 'eligibility' && key !== 'rules') {
      findings.push(malformed(decision, `block:unknown-key:${key}`, `constraint block contains unknown field ${JSON.stringify(key)}`));
    }
  }
  if (raw.version !== 1) {
    findings.push(malformed(decision, 'version', `unsupported version ${JSON.stringify(raw.version)} (expected 1)`));
  }
  if (!Array.isArray(raw.rules)) {
    findings.push(malformed(decision, 'rules', 'rules must be an array'));
  } else if (raw.rules.length > 256) {
    findings.push(malformed(decision, 'rules:limit', 'rules exceeds the 256-entry decision constraint limit'));
  }

  let eligibility: DecisionConstraintEligibility = unclassified;
  if (raw.eligibility !== undefined) {
    if (!raw.eligibility || typeof raw.eligibility !== 'object' || Array.isArray(raw.eligibility)) {
      findings.push(malformed(decision, 'eligibility', 'eligibility must be an object'));
    } else {
      const candidate = raw.eligibility as Record<string, unknown>;
      for (const key of Object.keys(candidate)) {
        if (!['status', 'reason', 'enforcedBoundary', 'humanReviewRemainder'].includes(key)) {
          findings.push(malformed(decision, `eligibility:unknown-key:${key}`, `eligibility contains unknown field ${JSON.stringify(key)}`));
        }
      }
      if (candidate.status !== 'eligible' && candidate.status !== 'ineligible' && candidate.status !== 'unclassified') {
        findings.push(malformed(decision, 'eligibility:status', 'eligibility.status must be eligible, ineligible, or unclassified'));
      } else if (candidate.status === 'ineligible'
        && (typeof candidate.reason !== 'string' || candidate.reason.trim() === '' || candidate.reason.length > MAX_POLICY_TEXT)) {
        findings.push(malformed(decision, 'eligibility:reason', 'an ineligible classification requires a stated reason'));
      } else if (candidate.status === 'eligible'
        && (typeof candidate.enforcedBoundary !== 'string' || candidate.enforcedBoundary.trim() === ''
          || candidate.enforcedBoundary.length > MAX_POLICY_TEXT)) {
        findings.push(malformed(decision, 'eligibility:boundary', 'an eligible classification requires a stated enforced boundary'));
      } else if (candidate.humanReviewRemainder !== undefined
        && (typeof candidate.humanReviewRemainder !== 'string' || candidate.humanReviewRemainder.trim() === ''
          || candidate.humanReviewRemainder.length > MAX_POLICY_TEXT)) {
        findings.push(malformed(decision, 'eligibility:partial', 'a human-review remainder must be a bounded non-empty string'));
      } else {
        eligibility = candidate.status === 'eligible'
          ? {
              status: 'eligible',
              enforcedBoundary: candidate.enforcedBoundary as string,
              ...(typeof candidate.humanReviewRemainder === 'string'
                ? { humanReviewRemainder: candidate.humanReviewRemainder }
                : {}),
            }
          : candidate.status === 'ineligible'
            ? { status: 'ineligible', reason: candidate.reason as string }
            : { status: 'unclassified' };
      }
    }
  }

  const rules: ArchitectureRule[] = [];
  const ids = new Set<string>();
  if (Array.isArray(raw.rules) && raw.rules.length <= 256) {
    raw.rules.forEach((rule, index) => {
      const parsed = parseOneRule(decision, rule, index, provenance);
      findings.push(...parsed.findings);
      if (parsed.id) {
        if (ids.has(parsed.id)) {
          findings.push(malformed(decision, `rule:${parsed.id}:duplicate`, `rule id ${JSON.stringify(parsed.id)} is duplicated`));
          return;
        }
        ids.add(parsed.id);
      }
      if (parsed.rule) rules.push(parsed.rule);
    });
  }
  if (eligibility.status === 'ineligible' && rules.length > 0) {
    findings.push(malformed(decision, 'eligibility:contradiction', 'an ineligible decision cannot declare active rules'));
  }
  if (findings.length > 0) return { rules: [], eligibility, findings };
  return { rules, eligibility, findings };
}

async function loadCorpusDecisions(rootPath: string, openspecPath: string): Promise<CorpusDecision[]> {
  const [store, durable] = await Promise.all([
    loadDecisionStore(rootPath),
    loadDurableDecisionProjections(rootPath, openspecPath),
  ]);
  const durableGroups = new Map<string, typeof durable>();
  for (const projection of durable) {
    const group = durableGroups.get(projection.decision.id) ?? [];
    group.push(projection);
    durableGroups.set(projection.decision.id, group);
  }
  const records: CorpusDecision[] = [];
  for (const [id, projections] of durableGroups) {
    const markerEntries = projections.flatMap((projection) =>
      parseDecisionConstraintMarkers(projectionConstraintText(projection)));
    const errors = [
      ...projections.flatMap((projection) => projection.statusError ? [projection.statusError] : []),
      ...markerEntries.flatMap((entry) => entry.error ? [entry.error] : []),
    ];
    for (const projection of projections) {
      if (projection.text.includes(MARKER_LABEL) && !markerOccupiesGeneratedSlot(projection, id)) {
        errors.push(`${projection.path} has a constraint marker outside decision ${id}'s generated structural slot`);
      }
    }
    const payloads = markerEntries.flatMap((entry) => entry.payload ? [entry.payload] : []);
    if (payloads.length > 0 || projections.some((projection) => projection.text.includes(MARKER_LABEL))) {
      for (const projection of projections) {
        const count = parseDecisionConstraintMarkers(projectionConstraintText(projection)).length;
        if (count !== 1) errors.push(`${projection.path} contains ${count} constraint markers for decision ${id} (expected exactly 1)`);
      }
    }
    // Durable projections are rendered canonically at write time. Compare the
    // parsed payload directly here: canonicalizing untrusted malformed rule
    // elements before validation would make the supposedly-total parser throw.
    const canonical = new Set(payloads.map((payload) => jsonForMarker(payload)));
    if (canonical.size > 1) errors.push(`durable spec/ADR projections disagree for decision ${id}`);
    const statuses = new Set(projections.map((projection) => projection.decision.status));
    if (statuses.size > 1) errors.push(`durable spec/ADR statuses disagree for decision ${id}`);
    const pathCounts = new Map<string, number>();
    for (const projection of projections) pathCounts.set(projection.path, (pathCounts.get(projection.path) ?? 0) + 1);
    for (const [path, count] of pathCounts) {
      if (count > 1) errors.push(`${path} contains ${count} durable projections for decision ${id}`);
    }
    const base = projections[0].decision;
    const candidate = payloads[0];
    if (candidate) {
      if (projections.some((projection) => candidate.title !== projection.decision.title)) {
        errors.push(`constraint marker title disagrees with visible decision ${id}`);
      }
      if (projections.some((projection) => candidate.rationale !== projection.decision.rationale)) {
        errors.push(`constraint marker rationale disagrees with visible decision ${id}`);
      }
      if (projections.some((projection) => candidate.supersedes !== projection.decision.supersedes)) {
        errors.push(`constraint marker supersedes disagrees with visible decision ${id}`);
      }
    }
    const payload = errors.length === 0 ? candidate : undefined;
    const projectionProvenances = await Promise.all(projections.map((projection) =>
      reviewedFileContentProvenance(rootPath, projection.path)));
    records.push({
      decision: base,
      constraints: payload?.constraints,
      provenance: projectionProvenances.every((value) => value === 'reviewed-corpus')
        ? 'reviewed-corpus'
        : 'local-unreviewed',
      ...(errors.length > 0 ? { markerErrors: [...new Set(errors)].sort(stableCompare) } : {}),
    });
  }
  const byId = new Map(records.map((record) => [record.decision.id, record]));
  for (const decision of store.decisions) {
    const durableRecord = byId.get(decision.id);
    if (durableRecord && (decision.status === 'rejected' || decision.status === 'phantom')) {
      byId.set(decision.id, {
        decision,
        constraints: decision.constraints,
        provenance: decisionContentProvenance(decision) as 'reviewed-corpus' | 'local-unreviewed',
        markerErrors: ['non-authoritative pending lifecycle conflicts with an authoritative durable projection'],
        authorityConflict: true,
      });
      continue;
    }
    if (durableRecord && isAuthoritative(durableRecord.decision.status) && !isAuthoritative(decision.status)) continue;
    if (durableRecord && isAuthoritative(durableRecord.decision.status) && isAuthoritative(decision.status)) {
      let projectionsAgree = false;
      try {
        const durableBytes = durableRecord.constraints
          ? jsonForMarker(canonicalPayload({
              decisionId: durableRecord.decision.id,
              title: durableRecord.decision.title,
              rationale: durableRecord.decision.rationale,
              ...(durableRecord.decision.supersedes ? { supersedes: durableRecord.decision.supersedes } : {}),
              constraints: durableRecord.constraints,
            }))
          : '';
        const pendingBytes = decision.constraints ? renderDecisionConstraintMarker(decision).slice(MARKER_LABEL.length) : '';
        projectionsAgree = durableBytes === pendingBytes;
      } catch {
        // The runtime validator below owns malformed-data diagnostics. A failed
        // canonicalization is necessarily a projection conflict, never authority.
      }
      if (!projectionsAgree || durableRecord.markerErrors?.length) {
        byId.set(decision.id, {
          decision,
          provenance: decisionContentProvenance(decision) as 'reviewed-corpus' | 'local-unreviewed',
          markerErrors: [...(durableRecord.markerErrors ?? []), 'authoritative pending and durable constraint projections disagree'],
          authorityConflict: true,
        });
        continue;
      }
    }
    byId.set(decision.id, {
      decision,
      constraints: decision.constraints,
      provenance: decisionContentProvenance(decision) as 'reviewed-corpus' | 'local-unreviewed',
    });
  }
  return [...byId.values()].sort((a, b) => stableCompare(a.decision.id, b.decision.id));
}

export async function loadDecisionConstraintState(
  rootPath: string,
  openspecPath = 'openspec',
): Promise<DecisionConstraintState> {
  const corpus = await loadCorpusDecisions(rootPath, openspecPath);
  const rules: ArchitectureRule[] = [];
  const malformedFindings: GovernanceFinding[] = [];
  const retiredRules: RetiredDecisionRule[] = [];
  const receipts: EligibilityDecisionReceipt[] = [];
  const authoritativeById = new Map(corpus
    .filter(({ decision }) => isAuthoritative(decision.status))
    .map(({ decision }) => [decision.id, decision]));
  const edges = new Map<string, string>();
  for (const decision of authoritativeById.values()) {
    if (!decision.supersedes) continue;
    if (decision.supersedes === decision.id) {
      malformedFindings.push(malformed(decision, 'supersession:self', 'a decision cannot supersede itself'));
      continue;
    }
    edges.set(decision.id, decision.supersedes);
  }
  const cycleMembers = new Set<string>();
  for (const start of [...edges.keys()].sort(stableCompare)) {
    const path: string[] = [];
    const position = new Map<string, number>();
    let cursor: string | undefined = start;
    while (cursor && edges.has(cursor) && !position.has(cursor)) {
      position.set(cursor, path.length);
      path.push(cursor);
      cursor = edges.get(cursor);
    }
    if (cursor && position.has(cursor)) {
      for (const id of path.slice(position.get(cursor))) cycleMembers.add(id);
    }
  }
  for (const id of [...cycleMembers].sort(stableCompare)) {
    malformedFindings.push(malformed(
      authoritativeById.get(id)!,
      'supersession:cycle',
      'authoritative supersession cycle has no terminal decision',
    ));
  }
  const superseded = new Set<string>(cycleMembers);
  for (const [source, target] of edges) {
    if (!cycleMembers.has(source) && !cycleMembers.has(target)) superseded.add(target);
  }
  let violationAssessmentComplete = malformedFindings.length === 0;

  for (const record of corpus) {
    const { decision, constraints } = record;
    const authoritative = isAuthoritative(decision.status) && !superseded.has(decision.id);
    const markerFindings = (record.markerErrors ?? []).map((error, index) =>
      malformed(decision, `durable-marker:${index}`, error));
    const validated = constraints
      ? validateBlock(decision, constraints, record.provenance)
      : { rules: [], eligibility: { status: 'unclassified' } as DecisionConstraintEligibility, findings: [] };
    malformedFindings.push(...markerFindings, ...validated.findings);
    if (record.authorityConflict
      || (authoritative && (markerFindings.length > 0 || validated.findings.length > 0))) {
      violationAssessmentComplete = false;
    }
    if (authoritative) {
      rules.push(...validated.rules);
      receipts.push({
        decisionId: decision.id,
        title: decision.title,
        status: validated.eligibility.status,
        constrained: validated.rules.length > 0,
        servedContentMetadata: {
          provenance: record.provenance,
        },
        ...('reason' in validated.eligibility ? { reason: validated.eligibility.reason } : {}),
        ...('enforcedBoundary' in validated.eligibility ? { enforcedBoundary: validated.eligibility.enforcedBoundary } : {}),
        ...('humanReviewRemainder' in validated.eligibility && validated.eligibility.humanReviewRemainder
          ? { humanReviewRemainder: validated.eligibility.humanReviewRemainder }
          : {}),
      });
    } else {
      const status: RetiredDecisionRule['status'] = superseded.has(decision.id) ? 'superseded' : decision.status;
      for (const rule of validated.rules) {
        retiredRules.push({
          decisionId: decision.id,
          decisionTitle: decision.title,
          ruleId: rule.ruleId!,
          status,
        });
      }
    }
  }

  rules.sort((a, b) => stableCompare(
    `${a.decision?.id ?? ''}\0${a.ruleId ?? ''}`,
    `${b.decision?.id ?? ''}\0${b.ruleId ?? ''}`,
  ));
  malformedFindings.sort((a, b) => stableCompare(
    `${a.subject}\0${a.discriminator ?? ''}\0${a.message}`,
    `${b.subject}\0${b.discriminator ?? ''}\0${b.message}`,
  ));
  retiredRules.sort((a, b) => stableCompare(`${a.decisionId}\0${a.ruleId}`, `${b.decisionId}\0${b.ruleId}`));
  receipts.sort((a, b) => stableCompare(a.decisionId, b.decisionId));

  const constrained = receipts.filter((receipt) => receipt.constrained).length;
  const eligible = receipts.filter((receipt) => receipt.status === 'eligible');
  const constrainedEligible = eligible.filter((receipt) => receipt.constrained).length;
  const ledger: EnforcementEligibilityLedger = {
    adoption: {
      constrained,
      authoritative: receipts.length,
      ratio: receipts.length === 0 ? null : constrained / receipts.length,
    },
    coverage: {
      constrainedEligible,
      eligible: eligible.length,
      ratio: eligible.length === 0 ? null : constrainedEligible / eligible.length,
    },
    unclassifiedCount: receipts.filter((receipt) => receipt.status === 'unclassified').length,
    activeRuleCount: rules.length,
    coverageGaps: eligible
      .filter((receipt) => !receipt.constrained)
      .map(({ decisionId, title }) => ({ decisionId, title })),
    decisions: receipts,
  };

  return {
    rules,
    warnings: [],
    malformedFindings,
    retiredRules,
    ledger,
    violationAssessmentComplete,
  };
}

/** Input-boundary validation used by record_decision before persisting bytes. */
export function validateDecisionConstraintBlock(
  decision: Pick<PendingDecision, 'id' | 'title' | 'rationale'>,
  block: unknown,
): GovernanceFinding[] {
  const synthetic: PendingDecision = {
    ...decision,
    status: 'draft',
    consequences: '',
    proposedRequirement: null,
    affectedDomains: [],
    affectedFiles: [],
    sessionId: '',
    recordedAt: '',
    contentOrigin: 'agent-recorded',
    confidence: 'medium',
    syncedToSpecs: [],
  };
  const findings = validateBlock(synthetic, block).findings;
  if (decision.title.length > MAX_POLICY_TEXT || decision.rationale.length > MAX_POLICY_TEXT) {
    findings.push(malformed(synthetic, 'metadata:limit', `decision title and rationale must each be at most ${MAX_POLICY_TEXT} characters when constraints are declared`));
  }
  if (/^(?:\*\*ID:\*\*|> Decision ID:|> OpenLore constraints:|\s*`{3,}|\s*~{3,})/m.test(decision.rationale)) {
    findings.push(malformed(synthetic, 'metadata:structure', 'decision rationale cannot forge a durable decision or constraint marker structure'));
  }
  if (findings.length === 0) {
    const marker = renderDecisionConstraintMarker({
      ...synthetic,
      constraints: block as DecisionConstraintBlock,
    });
    if (Buffer.byteLength(marker.slice(MARKER_LABEL.length), 'utf8') > MAX_MARKER_BYTES) {
      findings.push(malformed(synthetic, 'marker:limit', `canonical constraint marker exceeds ${MAX_MARKER_BYTES} bytes`));
    }
  }
  return findings;
}

/** Structural guard anchor: decision eligibility is parsed, never inferred. */
export const DECISION_ELIGIBILITY_IS_DECLARED_ONLY = true;

export function decisionConstraintViolationFindings(
  graph: DependencyGraphResult,
  state: DecisionConstraintState,
): GovernanceFinding[] {
  return scanViolations(graph, { rules: state.rules, warnings: state.warnings }).violations
    .filter((violation) => violation.decision && violation.ruleId)
    .map((violation): GovernanceFinding => ({
      code: 'decision-constraint-violation',
      severity: 'error',
      source: 'decision-constraint',
      subject: violation.from,
      discriminator: `${violation.decision!.id}:${violation.ruleId}:${violation.to}`,
      location: { path: violation.from },
      decision: {
        id: violation.decision!.id,
        title: violation.decision!.title,
        rationale: violation.decision!.rationale,
        ruleId: violation.ruleId!,
        servedContentMetadata: violation.decision!.servedContentMetadata,
      },
      message:
        `Decision ${violation.decision!.id} (${violation.decision!.title}), rule ${violation.ruleId}, ` +
        `governs ${violation.from}: dependency on ${violation.to} violates the rule (${violation.reason}). ` +
        `Rationale: ${violation.decision!.rationale}`,
    }))
    .sort((a, b) => stableCompare(
      `${a.subject}\0${a.discriminator ?? ''}\0${a.message}`,
      `${b.subject}\0${b.discriminator ?? ''}\0${b.message}`,
    ));
}
