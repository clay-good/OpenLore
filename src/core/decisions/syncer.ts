/**
 * Decision syncer
 *
 * Writes approved decisions into OpenSpec spec.md files (append-only)
 * and creates ADR files for architectural decisions.
 * Never rewrites existing content.
 */

import { readFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { toRepositoryPath } from '../analyzer/file-walker.js';
import { fileExists } from '../../utils/command-helpers.js';
import { safeJoin } from '../../utils/path-confinement.js';
import { logger } from '../../utils/logger.js';
import { parseSpecHeader } from '../drift/spec-mapper.js';
import type { PendingDecision, DecisionStore, SpecMap, DecisionScope } from '../../types/index.js';
import { patchDecision, purgeInactiveDecisions, updateDecisionStore } from './store.js';
import { renderDecisionConstraintMarker, validateDecisionConstraintBlock } from './constraint-ledger.js';
import { atomicWriteFile } from './atomic-store.js';

/**
 * ADRs are durable architectural memory, not a log of every implementation choice.
 * Only cross-domain and system decisions are persisted as ADRs to avoid semantic
 * dilution and retrieval pollution in the vector index.
 */
const ADR_SCOPES = new Set<DecisionScope>(['cross-domain', 'system']);

function qualifiesForADR(decision: PendingDecision): boolean {
  return ADR_SCOPES.has(decision.scope ?? 'component');
}

export interface SyncOptions {
  rootPath: string;
  openspecPath: string;
  specMap: SpecMap;
  dryRun?: boolean;
  /**
   * Also sync `auto-approved` decisions (decision autopilot). Unlike `approved`
   * decisions — which transition to `synced` and purge — an auto-approved
   * decision keeps its status after the spec write (it stays in the store as the
   * human review queue) and its spec entry carries the
   * "Auto-accepted (unreviewed)" marker. (change: add-decision-autopilot)
   */
  includeAutoApproved?: boolean;
}

export interface SyncResult {
  synced: PendingDecision[];
  errors: Array<{ id: string; error: string }>;
  modifiedSpecs: string[];
}

export async function syncApprovedDecisions(
  store: DecisionStore,
  options: SyncOptions,
): Promise<{ store: DecisionStore; result: SyncResult }> {
  const approved = store.decisions.filter((d) => d.status === 'approved');
  // Auto-approved decisions re-sync idempotently (spec writes dedupe by id), so
  // ones already written are skipped by their recorded syncedToSpecs.
  const autoApproved = options.includeAutoApproved
    ? store.decisions.filter((d) => d.status === 'auto-approved' && d.syncedToSpecs.length === 0)
    : [];
  const synced: PendingDecision[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  const modifiedSpecs = new Set<string>();
  const originalById = new Map(store.decisions.map((decision) => [decision.id, decision]));
  const concurrencyConflicts = new Set<string>();

  let updatedStore = store;

  for (const decision of approved) {
    try {
      const modified = await syncDecision(decision, options);
      for (const p of modified) modifiedSpecs.add(p);
      const now = new Date().toISOString();
      updatedStore = patchDecision(updatedStore, decision.id, {
        status: 'synced',
        syncedAt: now,
        syncedToSpecs: modified,
      });
      synced.push({ ...decision, status: 'synced', syncedAt: now, syncedToSpecs: modified });
    } catch (err) {
      errors.push({ id: decision.id, error: String(err) });
    }
  }

  for (const decision of autoApproved) {
    try {
      const modified = await syncDecision(decision, options);
      for (const p of modified) modifiedSpecs.add(p);
      const now = new Date().toISOString();
      // Status stays 'auto-approved': the decision remains in the store as the
      // human review queue until promoted or rejected.
      updatedStore = patchDecision(updatedStore, decision.id, {
        syncedAt: now,
        syncedToSpecs: modified,
      });
      synced.push({ ...decision, syncedAt: now, syncedToSpecs: modified });
    } catch (err) {
      errors.push({ id: decision.id, error: String(err) });
    }
  }

  if (!options.dryRun) {
    // Purge happens only after all per-decision syncs complete (errors kept in store).
    // Invariant: store and ADR files agree — a decision is removed from store only after
    // status='synced', which is set only after spec + ADR writes succeed (or are skipped).
    // Partial failure leaves the decision in store at status='approved', safe to retry.
    //
    // CAS persist: the synced snapshot (`updatedStore`) is authoritative for the
    // decisions being synced, but we graft in any decision present on disk yet
    // absent from the snapshot — a draft recorded concurrently — so a competing
    // write is preserved rather than clobbered.
    const snapshot = updatedStore;
    const snapshotIds = new Set(snapshot.decisions.map((d) => d.id));
    const attemptedIds = new Set([...approved, ...autoApproved].map((decision) => decision.id));
    updatedStore = await updateDecisionStore(options.rootPath, (disk) => {
      const changedDuringSync = disk.decisions.filter((decision) => {
        if (!attemptedIds.has(decision.id)) return false;
        return JSON.stringify(decision) !== JSON.stringify(originalById.get(decision.id));
      });
      for (const decision of changedDuringSync) concurrencyConflicts.add(decision.id);
      const conflictIds = new Set(changedDuringSync.map((decision) => decision.id));
      const extras = disk.decisions.filter((d) => !snapshotIds.has(d.id));
      const merged = {
        ...snapshot,
        sessionId: disk.sessionId,
        lastConsolidatedAt: disk.lastConsolidatedAt ?? snapshot.lastConsolidatedAt,
        lastConsolidatedSourceFingerprint:
          disk.lastConsolidatedSourceFingerprint ?? snapshot.lastConsolidatedSourceFingerprint,
        decisions: [
          ...snapshot.decisions.filter((decision) => !conflictIds.has(decision.id)),
          ...changedDuringSync,
          ...extras,
        ],
      };
      const purged = purgeInactiveDecisions(merged);
      // Retain a concurrent rejection/phantom tombstone while the older durable
      // projection exists, so a later sync cannot reactivate rejected policy.
      const inactiveConflicts = changedDuringSync.filter((decision) =>
        decision.status === 'rejected' || decision.status === 'phantom');
      return inactiveConflicts.length > 0
        ? {
            ...purged,
            decisions: [
              ...purged.decisions,
              ...inactiveConflicts.map((decision) => ({ ...decision, durableLifecycleConflict: true })),
            ],
          }
        : purged;
    });
    if (concurrencyConflicts.size > 0) {
      for (const id of concurrencyConflicts) {
        errors.push({ id, error: 'decision changed concurrently during sync; durable output is non-authoritative until reconciled' });
      }
      for (let index = synced.length - 1; index >= 0; index--) {
        if (concurrencyConflicts.has(synced[index].id)) synced.splice(index, 1);
      }
    }
  }

  return {
    store: updatedStore,
    result: { synced, errors, modifiedSpecs: [...modifiedSpecs] },
  };
}

async function syncDecision(
  decision: PendingDecision,
  options: SyncOptions,
): Promise<string[]> {
  validateDecisionRenderInputs(decision);
  if (decision.constraints) {
    const findings = validateDecisionConstraintBlock(decision, decision.constraints);
    if (findings.length > 0) {
      throw new Error(findings.map((finding) => finding.message).join('; '));
    }
  }
  const modified: string[] = [];

  // Resolve each affected domain to a real spec file, preserving order.
  const resolved: Array<{ domain: string; specPath: string; specAbsPath: string }> = [];
  for (const domain of decision.affectedDomains) {
    const mapping = options.specMap.byDomain.get(domain);
    if (!mapping) {
      logger.warning(`Decision "${decision.title}": domain "${domain}" not found in spec map — skipping sync to spec`);
      continue;
    }

    // A repo can COMMIT a symlink at `openspec/specs/<domain>/spec.md`; git checks it
    // out, and this path is read, appended to and rewritten. Confine canonically so a
    // link pointing at ~/.zshrc resolves outside the root and is skipped.
    let specAbsPath: string;
    try {
      specAbsPath = safeJoin(options.rootPath, mapping.specPath);
    } catch {
      logger.warning(
        `Decision "${decision.title}": spec path for domain "${domain}" resolves outside the project — skipping sync to spec`,
      );
      continue;
    }
    if (!(await fileExists(specAbsPath))) continue;

    resolved.push({ domain, specPath: mapping.specPath, specAbsPath });
  }

  // Scope the write to a single owning domain: the first affected domain that
  // resolves to a spec gets the full requirement + Decisions entry; every other
  // affected domain gets a normative deferral to it, or a Decisions pointer when
  // there is no proposed requirement to defer to. Fanning the full block to every
  // domain (the old behavior) produced verbatim cross-domain duplicates —
  // e.g. an MCP-preset requirement bolted onto the drift, analyzer, and cli specs.
  // (Requirement: DecisionSyncWritesOneOwningDomain)
  const [owner, ...others] = resolved;
  if (decision.constraints && !owner && !qualifiesForADR(decision)) {
    throw new Error(
      `Decision ${decision.id} carries constraints but has no durable owning spec or ADR target; refusing to purge its only policy copy`,
    );
  }
  const backups = new Map<string, string>();
  const writtenBySync = new Map<string, string>();
  if (!options.dryRun) {
    for (const target of resolved) backups.set(target.specAbsPath, await readFile(target.specAbsPath, 'utf8'));
  }
  let createdADR: string | undefined;
  try {
    if (owner) {
      if (!options.dryRun) {
        writtenBySync.set(owner.specAbsPath, await appendToSpec(owner.specAbsPath, decision));
      }
      modified.push(owner.specPath);

      for (const other of others) {
        if (!options.dryRun) {
          const intended = await appendDecisionPointer(
            other.specAbsPath,
            other.specPath,
            decision,
            owner.domain,
            owner.specPath,
          );
          writtenBySync.set(other.specAbsPath, intended);
        }
        modified.push(other.specPath);
      }
    }

    if (qualifiesForADR(decision)) {
      if (options.dryRun) {
        const slug = toKebabCase(decision.title);
        modified.push(toRepositoryPath(join(relative(options.rootPath, options.openspecPath), 'decisions', `adr-XXXX-${slug}.md`)));
      } else {
        const adrPath = await createADR(decision, options);
        if (adrPath) {
          createdADR = join(options.rootPath, adrPath);
          modified.push(adrPath);
        }
      }
    }

    if (decision.constraints && !owner) {
      const durableADR = options.dryRun
        ? qualifiesForADR(decision)
        : Boolean(createdADR);
      if (!durableADR) {
        throw new Error(
          `Decision ${decision.id} carries constraints but no durable projection was written; retaining its pending policy copy`,
        );
      }
    }
  } catch (error) {
    if (!options.dryRun) {
      const rollbackErrors: string[] = [];
      for (const [path, content] of backups) {
        try {
          const current = await readFile(path, 'utf8');
          if (writtenBySync.has(path) && current !== writtenBySync.get(path)) {
            rollbackErrors.push(`${path} changed concurrently; preserving those bytes instead of rolling them back`);
          } else if (writtenBySync.has(path)) {
            await atomicWriteFile(path, content);
          }
        } catch (rollbackError) { rollbackErrors.push(String(rollbackError)); }
      }
      if (createdADR) {
        try { await rm(createdADR, { force: true }); } catch (rollbackError) { rollbackErrors.push(String(rollbackError)); }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`${String(error)}; rollback incomplete: ${rollbackErrors.join('; ')}`, { cause: error });
      }
    }
    throw error;
  }

  return modified;
}

async function appendToSpec(specPath: string, decision: PendingDecision): Promise<string> {
  let content = await readFile(specPath, 'utf-8');

  // 1. Update > Source files: header if new files present
  content = addSourceFiles(content, decision.affectedFiles);

  // 2. Append requirement block inside ## Requirements section
  if (decision.proposedRequirement) {
    content = appendRequirement(content, decision);
  }

  // 3. Append to ## Decisions section (create if absent)
  content = appendDecisionSection(content, decision);

  await atomicWriteFile(specPath, content);
  return content;
}

/** Write a schema-valid deferral or decision pointer into a non-owning domain.
 * The canonical requirement/decision entry still appears in full only once.
 * (Requirement: DecisionSyncWritesOneOwningDomain) */
async function appendDecisionPointer(
  specPath: string,
  mappedSpecPath: string,
  decision: PendingDecision,
  ownerDomain: string,
  ownerSpecPath: string,
): Promise<string> {
  const content = await readFile(specPath, 'utf-8');
  const next = appendDecisionPointerLine(
    content,
    mappedSpecPath,
    decision,
    ownerDomain,
    ownerSpecPath,
  );
  if (next !== content) await atomicWriteFile(specPath, next);
  return next;
}

function appendDecisionPointerLine(
  content: string,
  mappedSpecPath: string,
  decision: PendingDecision,
  ownerDomain: string,
  ownerSpecPath: string,
): string {
  // Idempotent by a marker distinct from the full-entry markers
  // (`> Decision recorded:` / `**ID:**`), so a re-sync never duplicates the
  // pointer and a domain that already holds the full entry is left untouched.
  const marker = `> Decision pointer: ${decision.id}`;
  if (hasDecisionPointer(content, decision.id) || hasDecisionEntry(content, decision.id)) {
    return content;
  }
  if (!decision.proposedRequirement) {
    const line = `${marker} — "${decision.title}" is recorded in \`${ownerSpecPath}\`; it also affects this domain.`;
    if (content.includes('## Decisions')) {
      return content.trimEnd() + '\n\n' + line + '\n';
    }
    return content.trimEnd() + '\n\n## Decisions\n\n' + line + '\n';
  }

  const slug = toPascalCase(decision.title);
  const relativeOwnerPath = relative(dirname(mappedSpecPath), ownerSpecPath)
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const block = `### Requirement: ${slug}

This domain SHALL conform to the canonical statement of decision \`${decision.id}\`, which lives in the
\`${ownerDomain}\` domain — see [${ownerDomain}/spec.md](${relativeOwnerPath}).

#### Scenario: The canonical statement governs

- **GIVEN** decision \`${decision.id}\` recorded in the \`${ownerDomain}\` domain
- **WHEN** this domain's behavior touches that decision's surface
- **THEN** it satisfies the canonical requirement as stated in [${ownerDomain}/spec.md](${relativeOwnerPath})

${marker} — "${decision.title}" is recorded in \`${ownerSpecPath}\`; it also affects this domain.
`;
  validateDecisionRequirementBlock(block, decision.id);
  return insertRequirementBlock(content, block);
}

function addSourceFiles(content: string, newFiles: string[]): string {
  if (newFiles.length === 0) return content;

  const { sourceFiles } = parseSpecHeader(content);
  const existing = new Set(sourceFiles);
  const toAdd = newFiles.filter((f) => !existing.has(f));
  if (toAdd.length === 0) return content;

  // Find the > Source files: line and append to it
  return content.replace(
    /^(>\s*Source files?:\s*.+)$/im,
    `$1, ${toAdd.join(', ')}`,
  );
}

function appendRequirement(content: string, decision: PendingDecision): string {
  // Idempotent: if this decision's requirement was already synced (by id), don't
  // append a second copy. Re-syncs and consolidation ID churn would otherwise
  // duplicate the block. The id marker is the stable dedupe key.
  if (hasDecisionRequirement(content, decision.id)) return content;
  const slug = toPascalCase(decision.title);
  const req = decision.proposedRequirement ?? '';
  const reqText = normalizeRequirementStatement(req, decision.id);
  const block = `### Requirement: ${slug}

${reqText}

> Decision recorded: ${decision.id}
> Date: ${decision.syncedAt ?? new Date().toISOString().slice(0, 10)}

#### Scenario: The decision requirement is enforced

- **GIVEN** approved decision \`${decision.id}\`
- **WHEN** the affected behavior is evaluated
- **THEN** ${reqText}
`;
  validateDecisionRequirementBlock(block, decision.id);

  return insertRequirementBlock(content, block);
}

/** Named failure surfaced as a per-decision sync error.
 * (change: fix-decision-sync-template-validity) */
class DecisionRequirementValidationError extends Error {
  constructor(decisionId: string, detail: string) {
    super(`DecisionRequirementValidationError [${decisionId}]: ${detail}`);
    this.name = 'DecisionRequirementValidationError';
  }
}

function validateDecisionRenderInputs(decision: PendingDecision): void {
  const fields: Array<[string, string]> = [
    ['id', decision.id],
    ['title', decision.title],
    ...(decision.proposedRequirement == null
      ? []
      : [['proposedRequirement', decision.proposedRequirement] as [string, string]]),
    ...decision.affectedDomains.map((value, index) => [`affectedDomains[${index}]`, value] as [string, string]),
    ...decision.affectedFiles.map((value, index) => [`affectedFiles[${index}]`, value] as [string, string]),
    ...(decision.supersedes == null
      ? []
      : [['supersedes', decision.supersedes] as [string, string]]),
  ];
  const multiline = fields.find(([, value]) => /[\r\n]/.test(value));
  if (multiline) {
    throw new DecisionRequirementValidationError(
      decision.id,
      `${multiline[0]} must be a single line`,
    );
  }
  for (const [field, value] of [
    ['rationale', decision.rationale],
    ['consequences', decision.consequences],
  ] as const) {
    if (/^#{1,6}[ \t]+\S/m.test(value)) {
      throw new DecisionRequirementValidationError(
        decision.id,
        `${field} must not contain Markdown headings`,
      );
    }
  }
}

function normalizeRequirementStatement(requirement: string, decisionId: string): string {
  const trimmed = requirement.trim();
  if (!trimmed) return trimmed;
  if (/[\r\n]/.test(trimmed)) {
    throw new DecisionRequirementValidationError(
      decisionId,
      'proposed requirement must be a single line',
    );
  }

  // Preserve an existing subject + normative modal (for example, "The orient
  // command SHALL ..."). A leading modal has no subject, so supply only the
  // subject; plain prose receives the complete default clause.
  const subjectModal = trimmed.match(/^(.+?\s+)(SHALL|MUST)\b/i);
  if (subjectModal) {
    return subjectModal[1] + subjectModal[2].toUpperCase() + trimmed.slice(subjectModal[0].length);
  }
  const leadingModal = trimmed.match(/^(SHALL|MUST)\b/i);
  if (leadingModal) {
    return `The system ${leadingModal[1].toUpperCase()}${trimmed.slice(leadingModal[0].length)}`;
  }
  return `The system SHALL ${trimmed}`;
}

function validateDecisionRequirementBlock(block: string, decisionId: string): void {
  if ((block.match(/^### Requirement:/gm) ?? []).length !== 1) {
    throw new DecisionRequirementValidationError(
      decisionId,
      'rendered block must contain exactly one requirement heading',
    );
  }

  const heading = block.match(/^### Requirement:[ \t]*(\S.*)$/m)?.[1]?.trim();
  if (!heading) {
    throw new DecisionRequirementValidationError(decisionId, 'missing requirement heading');
  }

  const statement = block
    .slice(block.indexOf('\n') + 1, block.indexOf('#### Scenario:'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('>'))
    .join(' ');
  if (!/^.+?\s+(SHALL|MUST)\b/.test(statement)) {
    throw new DecisionRequirementValidationError(
      decisionId,
      'requirement statement must contain a coherent subject followed by SHALL or MUST',
    );
  }

  if (!/^#### Scenario:[ \t]*\S.*$/m.test(block)) {
    throw new DecisionRequirementValidationError(decisionId, 'missing scenario heading');
  }
  for (const clause of ['GIVEN', 'WHEN', 'THEN']) {
    if (!new RegExp(`^- \\*\\*${clause}\\*\\*\\s+\\S`, 'm').test(block)) {
      throw new DecisionRequirementValidationError(decisionId, `scenario missing ${clause} clause`);
    }
  }
}

function insertRequirementBlock(content: string, block: string): string {
  // Keep requirement blocks inside the Requirements section. Specs can contain
  // arbitrary later sections (notably ## Sub-components), so stopping only at
  // a named set of sections can create a schema-invalid requirement.
  const requirementsMatch = /^##\s+Requirements\s*$/m.exec(content);
  if (requirementsMatch?.index !== undefined) {
    const afterRequirements = requirementsMatch.index + requirementsMatch[0].length;
    const nextSection = /^##\s+.+$/gm;
    nextSection.lastIndex = afterRequirements;
    const boundary = nextSection.exec(content);
    const insertAt = boundary?.index ?? content.length;
    return (
      content.slice(0, insertAt).trimEnd() +
      '\n\n' + block.trim() + '\n\n' +
      content.slice(insertAt).trimStart()
    );
  }

  // Legacy/incomplete specs have no Requirements section. Preserve the former
  // fallback so the caller can surface schema validation for the emitted block.
  return content.trimEnd() + '\n\n' + block.trim() + '\n';
}

function appendDecisionSection(content: string, decision: PendingDecision): string {
  // Idempotent: skip if this decision's entry (by id) is already present.
  if (hasDecisionEntry(content, decision.id)) return content;
  const entry = buildDecisionEntry(decision);

  if (content.includes('## Decisions')) {
    return content.trimEnd() + '\n\n' + entry.trimStart();
  }

  return content.trimEnd() + '\n\n## Decisions\n\n' + entry.trimStart();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasDecisionEntry(content: string, decisionId: string): boolean {
  return new RegExp(`^\\*\\*ID:\\*\\*[ \\t]+${escapeRegExp(decisionId)}[ \\t]*$`, 'm')
    .test(content);
}

function hasDecisionRequirement(content: string, decisionId: string): boolean {
  return new RegExp(`^> Decision recorded:[ \\t]+${escapeRegExp(decisionId)}[ \\t]*$`, 'm')
    .test(content);
}

function hasDecisionPointer(content: string, decisionId: string): boolean {
  return new RegExp(`^> Decision pointer:[ \\t]+${escapeRegExp(decisionId)}(?:[ \\t]|$)`, 'm')
    .test(content);
}

/** Human-visible status label for a spec Decisions entry. Auto-accepted
 * decisions are always marked unreviewed until a human promotes them —
 * provenance is disclosed, never silently upgraded. (add-decision-autopilot) */
export const AUTO_ACCEPTED_STATUS_LABEL = 'Auto-accepted (unreviewed)';

function specStatusLabel(decision: PendingDecision): string {
  return decision.approvedBy === 'autopilot' && !decision.humanReviewedAt
    ? AUTO_ACCEPTED_STATUS_LABEL
    : 'Approved';
}

function buildDecisionEntry(decision: PendingDecision): string {
  const constraintMarker = renderDecisionConstraintMarker(decision);
  return `### ${decision.title}

**Status:** ${specStatusLabel(decision)}
**Date:** ${(decision.syncedAt ?? new Date().toISOString()).slice(0, 10)}
**ID:** ${decision.id}
${decision.supersedes ? `**Supersedes:** ${decision.supersedes}\n` : ''}
${constraintMarker ? `${constraintMarker}\n` : ''}

${decision.rationale}

**Consequences:** ${decision.consequences}
`;
}

async function createADR(
  decision: PendingDecision,
  options: SyncOptions,
): Promise<string | null> {
  // Same symlink vector as the spec write above: a committed
  // `openspec/decisions -> ../../../.claude/commands` would otherwise plant an ADR
  // outside the repo. Confine before the mkdir that would follow the link.
  let decisionsDir: string;
  try {
    decisionsDir = safeJoin(options.rootPath, join(options.openspecPath, 'decisions'));
  } catch {
    logger.warning('openspec/decisions resolves outside the project — skipping ADR creation');
    return null;
  }
  await mkdir(decisionsDir, { recursive: true });

  // Find next ADR number
  let maxNum = 0;
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(decisionsDir);
    for (const f of files) {
      const m = f.match(/^adr-(\d+)/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
  } catch { /* empty dir */ }

  const num = String(maxNum + 1).padStart(4, '0');
  const slug = toKebabCase(decision.title);
  const filename = `adr-${num}-${slug}.md`;
  const adrPath = join(decisionsDir, filename);

  const domains = decision.affectedDomains.join(', ');
  const adrStatus = decision.approvedBy === 'autopilot' && !decision.humanReviewedAt
    ? 'accepted (auto-accepted, unreviewed)'
    : 'accepted';
  const constraintMarker = renderDecisionConstraintMarker(decision);
  const content = `# ADR-${num}: ${decision.title}

## Status

${adrStatus}

**Domains**: ${domains}

## Context

${decision.rationale}

## Decision

${decision.proposedRequirement ?? decision.title}

## Consequences

${decision.consequences}

> Recorded by openlore decisions on ${(decision.syncedAt ?? new Date().toISOString()).slice(0, 10)}
> Decision ID: ${decision.id}
${decision.supersedes ? `> Supersedes: ${decision.supersedes}\n` : ''}
${constraintMarker ? `${constraintMarker}\n` : ''}
`;

  await atomicWriteFile(adrPath, content);
  // Reported and matched against the POSIX spec corpus, so it must not carry the
  // platform separator (see the same rule in spec-mapper).
  return toRepositoryPath(relative(options.rootPath, adrPath));
}

// ============================================================================
// Human review of auto-accepted decisions (change: add-decision-autopilot)
// ============================================================================

/**
 * Rewrite the status marker of an already-synced decision across the spec/ADR
 * files it landed in. Used when a human reviews an auto-accepted decision:
 *   - promote → "Approved" (the unreviewed marker is dropped)
 *   - reject  → "Rejected (auto-acceptance reverted <date>)" — a supersession-
 *     style annotation, never a deletion: the entry (and its git history, for
 *     asOf queries) stays in place, only its authority label changes. A synced
 *     requirement block is annotated with a rejection line for the same reason.
 *
 * Returns the repo-relative paths actually modified. Missing files or absent
 * markers are skipped silently — the ledger, not the spec text, is the
 * authoritative trail; this is presentation-layer honesty.
 */
export async function rewriteSyncedDecisionStatus(
  rootPath: string,
  decision: PendingDecision,
  disposition: 'promoted' | 'rejected',
): Promise<string[]> {
  const date = new Date().toISOString().slice(0, 10);
  const newLabel = disposition === 'promoted'
    ? 'Approved'
    : `Rejected (auto-acceptance reverted ${date})`;
  const modified: string[] = [];

  for (const relPath of decision.syncedToSpecs) {
    // `syncedToSpecs` comes from the repo-committed decision store, so it is as
    // untrusted as the spec map `syncDecision` confines above — a store entry of
    // `"../../../../.zshenv"` (or an in-root symlink) would otherwise be read and
    // rewritten in place. Same guard, same reason; this sibling was missed first time.
    let absPath: string;
    try {
      absPath = safeJoin(rootPath, relPath);
    } catch {
      logger.warning(`Decision ${decision.id}: synced spec path "${relPath}" resolves outside the project — skipping status rewrite`);
      continue;
    }
    if (!(await fileExists(absPath))) continue;
    let content = await readFile(absPath, 'utf-8');
    const before = content;

    // Decisions-section entry: the Status line two lines above this id's marker.
    const entryRe = new RegExp(
      `(\\*\\*Status:\\*\\* )[^\\n]*(\\n\\*\\*Date:\\*\\* [^\\n]*\\n\\*\\*ID:\\*\\* ${decision.id}\\b)`,
    );
    content = content.replace(entryRe, `$1${newLabel}$2`);

    // ADR file: rewrite the Status section when this file carries the decision id.
    if (content.includes(`> Decision ID: ${decision.id}`)) {
      content = content.replace(
        /(## Status\n\n)[^\n]*/,
        `$1${disposition === 'promoted' ? 'accepted' : `rejected (auto-acceptance reverted ${date})`}`,
      );
    }

    // Synced requirement block: annotate on rejection so the requirement is not
    // read as authoritative; leave untouched on promotion (it already reads clean).
    if (disposition === 'rejected') {
      const reqMarker = `> Decision recorded: ${decision.id}`;
      if (content.includes(reqMarker) && !content.includes(`${reqMarker}\n> Rejected:`)) {
        content = content.replace(reqMarker, `${reqMarker}\n> Rejected: ${date} (auto-acceptance reverted by human review)`);
      }
    }

    if (content !== before) {
      await atomicWriteFile(absPath, content);
      modified.push(relPath);
    }
  }
  return modified;
}

function toPascalCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50);
}
