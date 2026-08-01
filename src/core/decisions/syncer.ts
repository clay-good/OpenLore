/**
 * Decision syncer
 *
 * Writes approved decisions into OpenSpec spec.md files (append-only)
 * and creates ADR files for architectural decisions.
 * Never rewrites existing content.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import { safeJoin } from '../../utils/path-confinement.js';
import { logger } from '../../utils/logger.js';
import { parseSpecHeader } from '../drift/spec-mapper.js';
import type { PendingDecision, DecisionStore, SpecMap, DecisionScope } from '../../types/index.js';
import { patchDecision, purgeInactiveDecisions, updateDecisionStore } from './store.js';

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
    updatedStore = await updateDecisionStore(options.rootPath, (disk) => {
      const extras = disk.decisions.filter((d) => !snapshotIds.has(d.id));
      return purgeInactiveDecisions({
        ...snapshot,
        sessionId: disk.sessionId,
        lastConsolidatedAt: disk.lastConsolidatedAt ?? snapshot.lastConsolidatedAt,
        decisions: [...snapshot.decisions, ...extras],
      });
    });
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
  // affected domain gets a normative deferral to it. Fanning the full block to
  // every domain (the old behavior) produced verbatim cross-domain duplicates —
  // e.g. an MCP-preset requirement bolted onto the drift, analyzer, and cli specs.
  // (Requirement: DecisionSyncWritesOneOwningDomain)
  const [owner, ...others] = resolved;
  if (owner) {
    if (!options.dryRun) await appendToSpec(owner.specAbsPath, decision);
    modified.push(owner.specPath);

    for (const other of others) {
      if (!options.dryRun) {
        await appendDecisionPointer(other.specAbsPath, decision, owner.domain, owner.specPath);
      }
      modified.push(other.specPath);
    }
  }

  if (qualifiesForADR(decision)) {
    if (options.dryRun) {
      const slug = toKebabCase(decision.title);
      modified.push(`openspec/decisions/adr-XXXX-${slug}.md`);
    } else {
      const adrPath = await createADR(decision, options);
      if (adrPath) modified.push(adrPath);
    }
  }

  return modified;
}

async function appendToSpec(specPath: string, decision: PendingDecision): Promise<void> {
  let content = await readFile(specPath, 'utf-8');

  // 1. Update > Source files: header if new files present
  content = addSourceFiles(content, decision.affectedFiles);

  // 2. Append requirement block inside ## Requirements section
  if (decision.proposedRequirement) {
    content = appendRequirement(content, decision);
  }

  // 3. Append to ## Decisions section (create if absent)
  content = appendDecisionSection(content, decision);

  await writeFile(specPath, content, 'utf-8');
}

/** Write a schema-valid normative deferral into a non-owning affected domain.
 * The canonical requirement + Decisions entry still appears in full only once.
 * (Requirement: DecisionSyncWritesOneOwningDomain) */
async function appendDecisionPointer(
  specPath: string,
  decision: PendingDecision,
  ownerDomain: string,
  ownerSpecPath: string,
): Promise<void> {
  const content = await readFile(specPath, 'utf-8');
  const next = appendDecisionPointerLine(content, decision, ownerDomain, ownerSpecPath);
  if (next !== content) await writeFile(specPath, next, 'utf-8');
}

function appendDecisionPointerLine(
  content: string,
  decision: PendingDecision,
  ownerDomain: string,
  ownerSpecPath: string,
): string {
  // Idempotent by a marker distinct from the full-entry markers
  // (`> Decision recorded:` / `**ID:**`), so a re-sync never duplicates the
  // pointer and a domain that already holds the full entry is left untouched.
  const marker = `> Decision pointer: ${decision.id}`;
  if (content.includes(marker) || content.includes(`**ID:** ${decision.id}`)) {
    return content;
  }
  const slug = toPascalCase(decision.title);
  const relativeOwnerPath = `../${ownerDomain}/spec.md`;
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
  if (content.includes(`> Decision recorded: ${decision.id}`)) return content;
  const slug = toPascalCase(decision.title);
  const req = decision.proposedRequirement ?? '';
  const reqText = normalizeRequirementStatement(req);
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

function normalizeRequirementStatement(requirement: string): string {
  const trimmed = requirement.trim();
  if (!trimmed) return trimmed;

  // Preserve an existing subject + normative modal (for example, "The orient
  // command SHALL ..."). A leading modal has no subject, so supply only the
  // subject; plain prose receives the complete default clause.
  if (/^.+?\s+(SHALL|MUST)\b/i.test(trimmed)) return trimmed;
  if (/^(SHALL|MUST)\b/i.test(trimmed)) return `The system ${trimmed}`;
  return `The system SHALL ${trimmed}`;
}

function validateDecisionRequirementBlock(block: string, decisionId: string): void {
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

  // Insert before ## Technical Notes or ## Architecture Notes or append before ## Decisions
  const sectionMatch = content.match(
    /^(##\s+(Technical Notes|Architecture Notes|Decisions))/m,
  );
  if (sectionMatch && sectionMatch.index !== undefined) {
    return (
      content.slice(0, sectionMatch.index).trimEnd() +
      '\n\n' + block.trim() + '\n\n' +
      content.slice(sectionMatch.index)
    );
  }

  return content.trimEnd() + '\n\n' + block.trim() + '\n';
}

function appendDecisionSection(content: string, decision: PendingDecision): string {
  // Idempotent: skip if this decision's entry (by id) is already present.
  if (content.includes(`**ID:** ${decision.id}`)) return content;
  const entry = buildDecisionEntry(decision);

  if (content.includes('## Decisions')) {
    return content.trimEnd() + '\n\n' + entry.trimStart();
  }

  return content.trimEnd() + '\n\n## Decisions\n\n' + entry.trimStart();
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
  return `### ${decision.title}

**Status:** ${specStatusLabel(decision)}
**Date:** ${(decision.syncedAt ?? new Date().toISOString()).slice(0, 10)}
**ID:** ${decision.id}

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
`;

  await writeFile(adrPath, content, 'utf-8');
  return `openspec/decisions/${filename}`;
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
      await writeFile(absPath, content, 'utf-8');
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
