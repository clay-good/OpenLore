/**
 * openlore decisions command
 *
 * Agent-recorded architectural decision workflow:
 *   record (via MCP) → consolidate → verify → approve → sync → spec.md
 *
 * Can be installed as a pre-commit hook that gates commits until decisions
 * are reviewed.
 */

import { Command } from 'commander';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { join } from 'node:path';

import { logger } from '../../utils/logger.js';
import { colorForStdout } from '../../utils/colors.js';
import { redirectConsoleToStderr } from '../../utils/quiet-stdout.js';
import { fileExists, resolveLLMProvider } from '../../utils/command-helpers.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { createLLMService } from '../../core/services/llm-service.js';
import { isGitRepository, getChangedFiles, getFileDiff, getCommitMessages, resolveBaseRef, buildSpecMap } from '../../core/drift/index.js';
import {
  loadDecisionStore,
  updateDecisionStore,
  replaceDecisions,
  patchDecision,
  getDecisionsByStatus,
  INACTIVE_STATUSES,
} from '../../core/decisions/store.js';
import { readLedger } from '../../core/decisions/ledger.js';
import { rewriteSyncedDecisionStatus } from '../../core/decisions/syncer.js';
import { consolidateDrafts } from '../../core/decisions/consolidator.js';
import { classifyGateState } from '../../core/decisions/gate-state.js';
import { acquireDecisionsLock } from '../../core/decisions/lock.js';
import { extractFromDiff } from '../../core/decisions/extractor.js';
import { verifyDecisions } from '../../core/decisions/verifier.js';
import { syncApprovedDecisions } from '../../core/decisions/syncer.js';
import {
  OPENLORE_DIR,
  OPENLORE_LOGS_SUBDIR,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  DECISIONS_EXTRACTION_MAX_FILES,
  DECISIONS_DIFF_MAX_CHARS,
  CONSOLIDATION_GRACE_PERIOD_MS,
  GATE_REASONS,
} from '../../constants.js';
import type { PendingDecision } from '../../types/index.js';
import { runTuiApproval } from '../tui-approval.js';
import { emit } from '../../core/services/telemetry.js';

// ============================================================================
// AGENT INSTRUCTION FILES
// ============================================================================

const AGENT_INSTRUCTIONS_MARKER = '<!-- openlore-decisions-instructions -->';

const AGENT_INSTRUCTIONS_BLOCK = `${AGENT_INSTRUCTIONS_MARKER}
## Architectural decisions

When making a significant design choice, call \`record_decision\` **before** writing the code.

Significant choices: data structure, library/dependency, API contract, auth strategy,
module boundary, database schema, caching approach, error handling pattern.

\`\`\`
record_decision({
  title: "Use JWTs for stateless auth",
  rationale: "Avoids session store in infra",
  consequences: "Tokens can't be revoked early",
  affectedFiles: ["src/auth/middleware.ts"],
  supersedes: "a1b2c3d4"  // 8-char ID of prior decision being reversed
})
\`\`\`

Decisions are consolidated in the background immediately after \`record_decision\` is called — the pre-commit gate reads the already-consolidated store and adds no LLM latency.

**Performance note**: if you skip \`record_decision\`, the gate detects unrecorded source changes at commit time and triggers a slow LLM extraction on the *next* commit (~10-30s). Calling \`record_decision\` proactively keeps every commit instant.

## When git commit is blocked by the decisions gate

If \`git commit\` fails and the output is JSON with \`"gated": true\`, do NOT retry silently.
Check the \`reason\` field and act accordingly:

**\`reason: "verified"\` — decisions await review:**
Present each decision to the user:
> "The commit is blocked — I found N architectural decision(s) to validate:
> 1. **[id]** Title — rationale
Do you approve? (yes/no)"
For each approval call \`approve_decision\`, for rejections call \`reject_decision\`.
Then run \`openlore decisions --sync\` and retry \`git commit\`.

**\`reason: "approved_not_synced"\` — decisions approved but not written to specs:**
Run \`openlore decisions --sync\` then retry \`git commit\`. Do not skip this step.

**\`reason: "drafts_pending_consolidation"\` — drafts were recorded but not yet consolidated:**
Present to the user:
> "N decision draft(s) were recorded but never consolidated. Run consolidation now? (~10-30s)"
If yes: run \`openlore decisions --consolidate --gate\` and handle the result.
If no: retry with \`git commit --no-verify\` to skip the gate.

**\`reason: "no_decisions_recorded"\` — source files staged but nothing recorded:**
Present to the user:
> "Source files are staged but no architectural decisions were recorded. Run fallback extraction to check for undocumented decisions? (~10-30s)"
If yes: run \`openlore decisions --consolidate --gate\` and handle the result.
If no: retry with \`git commit --no-verify\` to skip the gate.
<!-- end-openlore-decisions-instructions -->
`;

/** Inject decisions instructions into an existing agent file, idempotently. */
async function injectAgentInstructions(filePath: string): Promise<'injected' | 'already' | 'missing'> {
  if (!(await fileExists(filePath))) return 'missing';
  const content = await readFile(filePath, 'utf-8');
  if (content.includes(AGENT_INSTRUCTIONS_MARKER)) return 'already';
  await writeFile(filePath, content.trimEnd() + '\n\n' + AGENT_INSTRUCTIONS_BLOCK, 'utf-8');
  return 'injected';
}

/** Remove decisions instructions block from an agent file. */
async function removeAgentInstructions(filePath: string): Promise<void> {
  if (!(await fileExists(filePath))) return;
  const content = await readFile(filePath, 'utf-8');
  if (!content.includes(AGENT_INSTRUCTIONS_MARKER)) return;
  const cleaned = content
    .replace(/\n*<!-- openlore-decisions-instructions -->[\s\S]*?<!-- end-openlore-decisions-instructions -->\n*/g, '')
    .trim();
  await writeFile(filePath, cleaned + '\n', 'utf-8');
}

// ============================================================================
// HOOK MANAGEMENT
// ============================================================================

const HOOK_MARKER = '# openlore-decisions-hook';

const HOOK_CONTENT = `${HOOK_MARKER}
# Gate commits until architectural decisions are reviewed.
# Installed by: openlore setup --tools claude

# Prefer local build over global install.
if [ -f "./node_modules/.bin/openlore" ]; then
  ./node_modules/.bin/openlore decisions --gate 2>&1
  DECISIONS_EXIT=$?
elif [ -f "./dist/cli/index.js" ]; then
  node ./dist/cli/index.js decisions --gate 2>&1
  DECISIONS_EXIT=$?
else
  OPENLORE=$(command -v openlore 2>/dev/null)
  if [ -n "$OPENLORE" ] && "$OPENLORE" decisions --help 2>&1 | grep -q -- '--gate'; then
    "$OPENLORE" decisions --gate 2>&1
    DECISIONS_EXIT=$?
  else
    DECISIONS_EXIT=0
  fi
fi
if [ "$DECISIONS_EXIT" -ne 0 ]; then
  exit "$DECISIONS_EXIT"
fi
# Sentinel written on successful gate pass. Post-commit checks for its absence to detect --no-verify bypass.
touch "$(git rev-parse --git-dir 2>/dev/null || echo .git)/OPENLORE_GATE_RAN" 2>/dev/null || true
# end-openlore-decisions-hook
`;

const POST_COMMIT_HOOK_MARKER = '# openlore-decisions-post-hook';
const POST_COMMIT_HOOK_CONTENT = `${POST_COMMIT_HOOK_MARKER}
# Warn when the pre-commit gate was bypassed via --no-verify.
# post-commit is NOT skipped by --no-verify (only pre-commit and commit-msg are).
SENTINEL="$(git rev-parse --git-dir 2>/dev/null || echo .git)/OPENLORE_GATE_RAN"
if [ -f "$SENTINEL" ]; then
  rm -f "$SENTINEL"
else
  echo "" >&2
  echo "⚠️  openlore: pre-commit gate was bypassed (--no-verify)." >&2
  echo "    Architectural decisions were NOT reviewed for this commit." >&2
  echo "    Run: openlore decisions --consolidate --gate" >&2
  echo "" >&2
fi
# end-openlore-decisions-post-hook
`;

async function ensureGitignored(rootPath: string, entry: string): Promise<void> {
  const gitignorePath = join(rootPath, '.gitignore');
  let content = '';
  if (await fileExists(gitignorePath)) {
    content = await readFile(gitignorePath, 'utf-8');
    // Trailing-slash-insensitive segments, so `.openlore` and `.openlore/` match
    // but `.openlore` never falsely matches a sibling like `.openapi/` (B2a).
    const segs = (p: string) => p.trim().replace(/\/+$/, '').split('/').filter(Boolean);
    const want = segs(entry);
    for (const line of content.split('\n')) {
      const have = segs(line);
      if (have.length === 0) continue;
      // Skip if an existing line is identical, or a covering parent prefix
      // (e.g. existing `.openlore/` covers a new `.openlore/decisions/`).
      if (have.length <= want.length && have.every((s, i) => s === want[i])) return;
    }
  }
  await writeFile(gitignorePath, content.trimEnd() + '\n' + entry + '\n', 'utf-8');
  logger.discovery(`  → added ${entry} to .gitignore`);
}

export async function installPreCommitHook(rootPath: string): Promise<void> {
  const hooksDir = join(rootPath, '.git', 'hooks');
  const hookPath = join(hooksDir, 'pre-commit');

  if (!(await fileExists(join(rootPath, '.git')))) {
    logger.error('Not a git repository. Cannot install hook.');
    process.exitCode = 1;
    return;
  }

  await mkdir(hooksDir, { recursive: true });

  let existingContent = '';
  if (await fileExists(hookPath)) {
    existingContent = await readFile(hookPath, 'utf-8');
    if (existingContent.includes(HOOK_MARKER)) {
      // Still clean up legacy spec-gen block if present
      const cleaned = existingContent.replace(/\n*# spec-gen-decisions-hook[\s\S]*?# end-spec-gen-decisions-hook\n*/g, '');
      if (cleaned !== existingContent) {
        await writeFile(hookPath, cleaned, 'utf-8');
        logger.discovery('Removed legacy spec-gen-decisions-hook block.');
      } else {
        logger.success('Pre-commit hook already installed.');
      }
      return;
    }
    logger.discovery('Existing pre-commit hook found. Appending decisions gate.');
    // Strip legacy spec-gen block and trailing `exit 0` so our block is not unreachable.
    const stripped = existingContent
      .replace(/\n*# spec-gen-decisions-hook[\s\S]*?# end-spec-gen-decisions-hook\n*/g, '')
      .trimEnd()
      .replace(/\n*\nexit 0\s*$/, '');
    await writeFile(hookPath, stripped + '\n\n' + HOOK_CONTENT, 'utf-8');
  } else {
    await writeFile(hookPath, '#!/bin/sh\n\n' + HOOK_CONTENT, 'utf-8');
  }

  await chmod(hookPath, 0o755);
  logger.success('Pre-commit hook installed at .git/hooks/pre-commit');
  logger.discovery('Commits will be gated until decisions are approved. Use --no-verify to skip.');

  // Install post-commit hook to detect --no-verify bypass
  const postCommitPath = join(hooksDir, 'post-commit');
  let existingPostContent = '';
  if (await fileExists(postCommitPath)) {
    existingPostContent = await readFile(postCommitPath, 'utf-8');
    if (!existingPostContent.includes(POST_COMMIT_HOOK_MARKER)) {
      const strippedPost = existingPostContent.trimEnd().replace(/\n*\nexit 0\s*$/, '');
      await writeFile(postCommitPath, strippedPost + '\n\n' + POST_COMMIT_HOOK_CONTENT, 'utf-8');
    }
  } else {
    await writeFile(postCommitPath, '#!/bin/sh\n\n' + POST_COMMIT_HOOK_CONTENT, 'utf-8');
  }
  await chmod(postCommitPath, 0o755);
  logger.success('Post-commit hook installed at .git/hooks/post-commit (bypass detector)');

  // Ensure pending decisions store is not accidentally committed
  await ensureGitignored(rootPath, '.openlore/decisions/');

  // Inject record_decision instructions into existing agent context files
  const agentFiles = [
    { path: join(rootPath, 'CLAUDE.md'), label: 'CLAUDE.md' },
    { path: join(rootPath, 'AGENTS.md'), label: 'AGENTS.md' },
    { path: join(rootPath, '.cursorrules'), label: '.cursorrules' },
    { path: join(rootPath, '.clinerules', 'openlore.md'), label: '.clinerules/openlore.md' },
    { path: join(rootPath, '.github', 'copilot-instructions.md'), label: '.github/copilot-instructions.md' },
    { path: join(rootPath, '.windsurf', 'rules.md'), label: '.windsurf/rules.md' },
    { path: join(rootPath, '.vibe', 'skills', 'openlore.md'), label: '.vibe/skills/openlore.md' },
  ];

  for (const { path: filePath, label } of agentFiles) {
    const result = await injectAgentInstructions(filePath);
    if (result === 'injected') logger.discovery(`  → record_decision instructions added to ${label}`);
  }
}

export async function uninstallPreCommitHook(rootPath: string): Promise<void> {
  const hookPath = join(rootPath, '.git', 'hooks', 'pre-commit');

  if (!(await fileExists(hookPath))) {
    logger.warning('No pre-commit hook found.');
    return;
  }

  const content = await readFile(hookPath, 'utf-8');
  if (!content.includes(HOOK_MARKER)) {
    logger.warning('Pre-commit hook does not contain openlore decisions gate.');
    return;
  }

  const newContent = content
    .replace(/\n*# openlore-decisions-hook[\s\S]*?# end-openlore-decisions-hook\n*/g, '')
    .replace(/\n*# spec-gen-decisions-hook[\s\S]*?# end-spec-gen-decisions-hook\n*/g, '')
    .trim();

  if (!newContent || newContent === '#!/bin/sh') {
    const { unlink } = await import('node:fs/promises');
    await unlink(hookPath);
    logger.success('Pre-commit hook removed (file deleted — was only openlore).');
  } else {
    await writeFile(hookPath, newContent + '\n', 'utf-8');
    logger.success('OpenLore decisions gate removed from pre-commit hook.');
  }

  // Remove post-commit bypass detector
  const postCommitPath = join(rootPath, '.git', 'hooks', 'post-commit');
  if (await fileExists(postCommitPath)) {
    const postContent = await readFile(postCommitPath, 'utf-8');
    if (postContent.includes(POST_COMMIT_HOOK_MARKER)) {
      const newPostContent = postContent
        .replace(/\n*# openlore-decisions-post-hook[\s\S]*?# end-openlore-decisions-post-hook\n*/g, '')
        .trim();
      if (!newPostContent || newPostContent === '#!/bin/sh') {
        const { unlink } = await import('node:fs/promises');
        await unlink(postCommitPath);
        logger.success('Post-commit hook removed.');
      } else {
        await writeFile(postCommitPath, newPostContent + '\n', 'utf-8');
        logger.success('OpenLore bypass detector removed from post-commit hook.');
      }
    }
  }

  // Remove record_decision instructions from agent context files
  const agentFiles = [
    join(rootPath, 'CLAUDE.md'),
    join(rootPath, 'AGENTS.md'),
    join(rootPath, '.cursorrules'),
    join(rootPath, '.clinerules', 'openlore.md'),
    join(rootPath, '.github', 'copilot-instructions.md'),
    join(rootPath, '.windsurf', 'rules.md'),
    join(rootPath, '.vibe', 'skills', 'openlore.md'),
  ];
  for (const filePath of agentFiles) await removeAgentInstructions(filePath);
}

// Marker for the legacy full-`analyze` PostToolUse hook. The MCP server's
// `--watch-auto` (default since v2.0.6, Spec 13.1) is now the single freshness
// owner and keeps the index fresh incrementally O(change); the old hook ran a
// full O(repo) `openlore analyze` on *every* tool call (Read, Bash, …, masked
// only by a 10s lock) — pure double work. We no longer install it, and
// `uninstallClaudeHook` strips any copy a prior version left behind (Spec 26 B9).
const ANALYZE_HOOK_MARKER = 'openlore analyze';

interface ClaudeSettings {
  hooks?: {
    PostToolUse?: Array<{ _comment?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function uninstallClaudeHook(rootPath: string): Promise<void> {
  const settingsPath = join(rootPath, '.claude', 'settings.json');
  if (!(await fileExists(settingsPath))) return;

  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8')) as ClaudeSettings;
    const hooks = settings.hooks?.PostToolUse ?? [];
    const filtered = hooks.filter((h) => !JSON.stringify(h).includes('openlore-mine-last') && !JSON.stringify(h).includes(ANALYZE_HOOK_MARKER));
    if (filtered.length === hooks.length) return;
    if (filtered.length === 0) delete settings.hooks!.PostToolUse;
    else settings.hooks!.PostToolUse = filtered;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    logger.success('Claude Code PostToolUse hook removed from .claude/settings.json');
  } catch { /* settings corrupt — skip */ }
}

// ============================================================================
// DECISION AUTOPILOT (change: add-decision-autopilot)
// ============================================================================

/**
 * Autopilot gate resolution: auto-accept verified decisions (distinct
 * `auto-approved` status, actor `autopilot` on the ledger), sync them (plus any
 * human-approved ones) to specs, and NEVER block the commit — one advisory
 * stderr line, exit 0. Infrastructure failure degrades to a caveat and exit 0
 * (the impact-certificate advisory-safety discipline): a broken trail write or
 * sync must never stop a commit the human is making.
 *
 * Legality: only decisions still in `verified` transition — a human-`rejected`
 * decision is never resurrected by autopilot, and concurrent status changes
 * win (the CAS mutate re-checks status on the freshest store).
 */
async function runAutopilotGate(
  rootPath: string,
  config: NonNullable<Awaited<ReturnType<typeof readOpenLoreConfig>>>,
  jsonMode: boolean,
): Promise<void> {
  try {
    let store = await loadDecisionStore(rootPath);
    const verifiedIds = getDecisionsByStatus(store, 'verified').map((d) => d.id);

    if (verifiedIds.length > 0) {
      const now = new Date().toISOString();
      store = await updateDecisionStore(rootPath, (s) =>
        verifiedIds.reduce((acc, id) => {
          const cur = acc.decisions.find((d) => d.id === id);
          if (!cur || cur.status !== 'verified') return acc; // legality: verified-only
          return patchDecision(acc, id, {
            status: 'auto-approved',
            approvedBy: 'autopilot',
            reviewedAt: now,
          });
        }, s), 'autopilot');
      for (const id of verifiedIds) {
        const d = store.decisions.find((x) => x.id === id);
        if (d?.status === 'auto-approved') {
          emit(rootPath, 'decisions', { event: 'decision_auto_approved', id, title: d.title, transport: 'cli-gate' });
        }
      }
    }

    // Background-style sync in the same pass (deterministic, no LLM): approved
    // (human) decisions sync as today; auto-approved sync with the unreviewed
    // marker and stay in the store as the review queue.
    const accepted = store.decisions.filter((d) => d.status === 'auto-approved' && d.syncedToSpecs.length === 0);
    const approved = getDecisionsByStatus(store, 'approved');
    let syncedCount = 0;
    let syncErrors: Array<{ id: string; error: string }> = [];
    if (accepted.length > 0 || approved.length > 0) {
      const openspecPath = join(rootPath, config.openspecPath ?? OPENSPEC_DIR);
      if (await fileExists(join(openspecPath, OPENSPEC_SPECS_SUBDIR))) {
        const specMap = await buildSpecMap({ rootPath, openspecPath });
        const { result } = await syncApprovedDecisions(store, {
          rootPath, openspecPath, specMap, includeAutoApproved: true,
        });
        syncedCount = result.synced.length;
        syncErrors = result.errors;
      }
    }

    const fresh = await loadDecisionStore(rootPath);
    const draftCount = getDecisionsByStatus(fresh, 'draft').length;
    const unreviewedCount = fresh.decisions.filter((d) => d.status === 'auto-approved' && !d.humanReviewedAt).length;

    const parts: string[] = [];
    if (verifiedIds.length > 0) parts.push(`${verifiedIds.length} decision(s) auto-accepted`);
    if (syncedCount > 0) parts.push(`${syncedCount} synced to specs`);
    if (draftCount > 0) parts.push(`${draftCount} draft(s) pending background consolidation`);
    if (syncErrors.length > 0) parts.push(`${syncErrors.length} sync error(s) — will retry next gate`);
    if (parts.length > 0 || unreviewedCount > 0) {
      console.error(
        `openlore autopilot: ${parts.length ? parts.join(' · ') : 'nothing new'}`
        + `${unreviewedCount > 0 ? ` · ${unreviewedCount} awaiting review (openlore decisions review)` : ''}`
        + ` · trail: openlore decisions log`,
      );
    }
    if (jsonMode) {
      process.stdout.write(JSON.stringify({
        gated: false,
        autopilot: true,
        autoAccepted: verifiedIds.length,
        synced: syncedCount,
        draftsPending: draftCount,
        awaitingReview: unreviewedCount,
        syncErrors,
      }, null, 2) + '\n');
    }
    process.exitCode = 0;
  } catch (err) {
    // Advisory-safety: an autopilot fault never blocks the commit.
    console.error(`openlore autopilot: skipped (${(err as Error).message}) — commit not blocked`);
    process.exitCode = 0;
  }
}

// ============================================================================
// DISPLAY HELPERS
// ============================================================================

export function displayDecision(d: PendingDecision, verbose = false): void {
  const c = colorForStdout();

  // Glyphs are visually distinct across statuses AND across the "done vs not
  // done" divide: `verified` gate-BLOCKS a commit awaiting human review, so it
  // must never read as a done checkmark (✓/✔). See printDecisionLegend.
  const icon =
    d.status === 'verified'      ? c.yellow('⧖') :   // awaiting review (blocks the gate)
    d.status === 'phantom'       ? c.yellow('↗') :   // recorded but not in the diff
    d.status === 'approved'      ? c.blue('●')   :
    d.status === 'auto-approved' ? c.blue('◉')   :
    d.status === 'synced'        ? c.green('✔')  :
    d.status === 'rejected'      ? c.red('✗')    : c.dim('○');

  const confidence =
    d.confidence === 'high'   ? c.green('high') :
    d.confidence === 'medium' ? c.yellow('medium') :
                                c.red('low');

  const scopeLabel = d.scope ?? 'component';
  const scopeBadge =
    scopeLabel === 'system'       ? c.red(`[${scopeLabel}]`) :
    scopeLabel === 'cross-domain' ? c.yellow(`[${scopeLabel}]`) :
    scopeLabel === 'component'    ? c.blue(`[${scopeLabel}]`) :
                                    c.gray(`[${scopeLabel}]`);

  console.log(`${icon} [${d.id}] ${scopeBadge} ${d.title}`);
  if (verbose) {
    console.log(`   Status     : ${d.status}  Confidence: ${confidence}  Scope: ${scopeLabel}`);
    console.log(`   Rationale  : ${d.rationale}`);
    if (d.affectedDomains.length) console.log(`   Domains    : ${d.affectedDomains.join(', ')}`);
    if (d.proposedRequirement) console.log(`   Requirement: ${d.proposedRequirement}`);
    if (d.evidenceFile) console.log(`   Evidence   : ${d.evidenceFile}`);
  }
}

/**
 * One-line glyph legend printed beneath any decision listing. Its job is to make
 * a gate-blocking `verified` status legible as "awaiting review" — visually
 * distinct from the done statuses (approved/synced) — rather than a bare glyph
 * a reader has to guess at.
 */
export function printDecisionLegend(): void {
  const c = colorForStdout();
  console.log(
    `\nLegend: ${c.yellow('⧖')} awaiting review   ${c.blue('●')} approved   ` +
      `${c.blue('◉')} auto-accepted   ${c.green('✔')} synced   ${c.red('✗')} rejected   ` +
      `${c.yellow('↗')} phantom`,
  );
}

function displayMissing(missing: Array<{ file: string; description: string }>): void {
  if (missing.length === 0) return;
  logger.section('Unrecorded Changes Detected');
  for (const m of missing) {
    logger.warning(`⚠ ${m.file}: ${m.description}`);
  }
  console.log('These changes were not recorded as decisions. Consider adding them with record_decision.');
}

// ============================================================================
// COMMAND
// ============================================================================

export const decisionsCommand = new Command('decisions')
  .description('Record, consolidate, and sync architectural decisions to OpenSpec')
  .option('--consolidate', 'Consolidate drafts + verify against diff', false)
  .option('--gate', 'Exit non-zero if decisions await review (for use in hooks)', false)
  .option('--approve <id>', 'Approve a decision by ID')
  .option('--reject <id>', 'Reject a decision by ID')
  .option('--note <text>', 'Note to attach to approve/reject action')
  .option('--reason <text>', 'Alias for --note')
  .option('--sync', 'Sync all approved decisions to spec.md files', false)
  .option('--dry-run', 'Preview sync without writing', false)
  .option('--list', 'List decisions (default action when no other flag given)', false)
  .option('--status <status>', 'Filter list by status (draft|consolidated|verified|approved|auto-approved|rejected|synced)')
  .option('--uninstall-hook', 'Remove pre-commit hook', false)
  .option('--verbose', 'Show detailed decision info', false)
  .option('--json', 'Output as JSON', false)
  .addHelpText(
    'after',
    `
Workflow:
  1. Install once: openlore setup --tools claude  (hooks + skills)
  2. During dev: agent calls record_decision MCP tool
  3. At commit: openlore decisions --consolidate  (or via hook)
  4. Review: openlore decisions --approve <id>
  5. Write to spec: openlore decisions --sync

Examples:
  $ openlore decisions                             List pending decisions
  $ openlore decisions --consolidate               Consolidate + verify drafts
  $ openlore decisions --approve a1b2c3d4          Approve decision a1b2c3d4
  $ openlore decisions --sync                      Sync approved decisions
  $ openlore decisions --status verified --json    Machine-readable output
  $ openlore decisions log                         Transition ledger (audit trail)
  $ openlore decisions review                      Auto-accepted decisions awaiting review

Decision autopilot (opt-in: { "governance": { "autopilot": true } } in .openlore/config.json):
the gate auto-accepts verified decisions, syncs them to specs marked "Auto-accepted
(unreviewed)", and never blocks a commit. Every transition lands on the ledger.
`
  )
  .action(async function (this: Command, options: {
    consolidate: boolean;
    gate: boolean;
    approve?: string;
    reject?: string;
    note?: string;
    reason?: string;
    sync: boolean;
    dryRun: boolean;
    list: boolean;
    status?: string;
    uninstallHook: boolean;
    verbose: boolean;
    json: boolean;
  }) {
    // Top-level error boundary: an unexpected throw (LLM consolidate/verify, spec-map
    // build, git, or a spec write) becomes a friendly message + exit 1 rather than an
    // unhandled-rejection stack trace — matching drift/generate/verify.
    // --json: keep stdout pure (logs → stderr) by construction; all JSON payloads
    // are written via process.stdout.write, which bypasses the redirect.
    const restoreStdout = options.json ? redirectConsoleToStderr() : null;
    try {
    const globalOpts = this.parent?.opts() ?? {};
    const rootPath = process.cwd();

    // ── Hook management ──────────────────────────────────────────────────────
    if (options.uninstallHook) {
      await uninstallPreCommitHook(rootPath);
      await uninstallClaudeHook(rootPath); // cleans up any previously installed PostToolUse hook
      return;
    }
    // ── Load store (always needed) ───────────────────────────────────────────
    // `let` so the consolidate branch can re-read fresh state inside its lock.
    let store = await loadDecisionStore(rootPath);

    // ── Approve ──────────────────────────────────────────────────────────────
    if (options.approve) {
      const id = options.approve;
      const decision = store.decisions.find((d) => d.id === id);
      if (!decision) {
        logger.error(`Decision ${id} not found.`);
        process.exitCode = 1;
        return;
      }
      if (decision.status === 'synced') {
        logger.error(`Decision ${id} is already synced to spec files — re-approval not allowed.`);
        process.exitCode = 1;
        return;
      }
      const approvePatch = {
        status: 'approved' as const,
        approvedBy: 'human' as const,
        reviewedAt: new Date().toISOString(),
        reviewNote: options.note ?? options.reason,
      };
      // CAS so the write can't clobber a concurrent record/consolidate write.
      const updated = await updateDecisionStore(rootPath, (s) => patchDecision(s, id, approvePatch), 'human');
      emit(rootPath, 'decisions', { event: 'decision_approved', id, title: decision.title, transport: 'cli' });
      logger.success(`Decision ${id} approved.`);
      if (!options.json) displayDecision({ ...decision, status: 'approved' }, true);

      // Show a dry-run preview of what would land in the spec
      if (!options.json) {
        const openloreConfig = await readOpenLoreConfig(rootPath);
        if (openloreConfig) {
          const openspecPath = join(rootPath, openloreConfig.openspecPath ?? OPENSPEC_DIR);
          const specsExist = await fileExists(join(openspecPath, OPENSPEC_SPECS_SUBDIR));
          if (specsExist) {
            const specMap = await buildSpecMap({ rootPath, openspecPath }).catch(() => undefined);
            if (specMap) {
              const { result } = await syncApprovedDecisions(updated, {
                rootPath, openspecPath, specMap, dryRun: true,
              });
              if (result.modifiedSpecs.length > 0) {
                console.log(`\nWould write to: ${result.modifiedSpecs.join(', ')}`);
                console.log('Run "openlore decisions --sync" to apply.');
              }
            }
          }
        }
      }
      return;
    }

    // ── Reject ───────────────────────────────────────────────────────────────
    if (options.reject) {
      const id = options.reject;
      const decision = store.decisions.find((d) => d.id === id);
      if (!decision) {
        logger.error(`Decision ${id} not found.`);
        process.exitCode = 1;
        return;
      }
      await updateDecisionStore(rootPath, (s) => patchDecision(s, id, {
        status: 'rejected',
        reviewedAt: new Date().toISOString(),
        reviewNote: options.note ?? options.reason,
      }), 'human');
      emit(rootPath, 'decisions', { event: 'decision_rejected', id, title: decision.title, transport: 'cli' });
      logger.success(`Decision ${id} rejected.`);

      if (!options.json && decision.affectedFiles.length > 0) {
        console.log('\nIf this change should not be committed, revert it manually:');
        for (const f of decision.affectedFiles) {
          console.log(`  git restore ${f}`);
        }
        console.log('\nOr to document why this approach was rejected:');
        console.log('  openlore decisions --record');
        console.log('  (then re-run --consolidate before committing)');
      }
      return;
    }

    // ── Consolidate + Verify ─────────────────────────────────────────────────
    if (options.consolidate) {
      const openloreConfig = await readOpenLoreConfig(rootPath);
      if (!openloreConfig) {
        logger.error('No openlore configuration found. Run "openlore init" first.');
        process.exitCode = 1;
        return;
      }

      // Serialize consolidation across the detached `--consolidate` processes
      // that record_decision spawns: hold the lock for the whole
      // load → consolidate → save, and re-read the store INSIDE it so concurrent
      // records don't get clobbered (spec-15 dogfood fix).
      const releaseConsolidateLock = await acquireDecisionsLock(rootPath);
      try {
        store = await loadDecisionStore(rootPath);

      const drafts = getDecisionsByStatus(store, 'draft');
      const hasDrafts = drafts.length > 0;

      const resolved = resolveLLMProvider(openloreConfig);
      if (!resolved) {
        logger.error('No LLM provider configured. Consolidation requires an LLM.');
        logger.discovery('Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or configure llm in .openlore/config.json');
        process.exitCode = 1;
        return;
      }

      const llm = createLLMService({
        provider: resolved.provider,
        model: openloreConfig.generation?.model,
        openaiCompatBaseUrl: resolved.openaiCompatBaseUrl,
        apiBase: globalOpts.apiBase ?? openloreConfig.llm?.apiBase,
        sslVerify: globalOpts.insecure != null ? !globalOpts.insecure : (openloreConfig.llm?.sslVerify ?? true),
        enableLogging: true,
        logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
      });

      // Step 1 — Consolidate drafts OR extract from diff as fallback
      const openspecPath = join(rootPath, openloreConfig.openspecPath ?? OPENSPEC_DIR);
      const specMapResult = await buildSpecMap({ rootPath, openspecPath }).catch(() => undefined);
      let consolidated: PendingDecision[];
      let supersededIds: string[] = [];
      if (hasDrafts) {
        if (!options.json) logger.discovery(`Consolidating ${drafts.length} draft decision(s) via ${resolved.provider}...`);
        const result = await consolidateDrafts(store, llm, specMapResult);
        consolidated = result.decisions;
        supersededIds = result.supersededIds;
      } else {
        if (!options.json) logger.discovery(`No drafts found — extracting decisions from diff via ${resolved.provider}...`);
        const specMap = specMapResult ?? await buildSpecMap({ rootPath, openspecPath });
        // Use staged-only scope so the fallback only sees what's actually being committed.
        consolidated = await extractFromDiff({ rootPath, stagedOnly: true, specMap, sessionId: store.sessionId, llm });
      }
      if (consolidated.length === 0) {
        if (!options.json) console.log('No architectural decisions found in drafts.');
        if (options.gate) process.exitCode = 0;
        return;
      }

      // Step 2 — Build diff + commit messages for verification
      let combinedDiff = '';
      let commitMessages = '';
      try {
        if (await isGitRepository(rootPath)) {
          const baseRef = await resolveBaseRef(rootPath, 'auto');
          const gitResult = await getChangedFiles({ rootPath, baseRef, includeUnstaged: false });
          const relevant = gitResult.files.slice(0, DECISIONS_EXTRACTION_MAX_FILES);
          const diffs = await Promise.all(
            relevant.map((f) => getFileDiff(rootPath, f.path, baseRef, DECISIONS_DIFF_MAX_CHARS))
          );
          combinedDiff = diffs.join('\n\n');
          commitMessages = await getCommitMessages(rootPath, baseRef).catch(() => '');
        }
      } catch (err) {
        logger.warning(`Could not build git diff for verification: ${(err as Error).message}`);
      }

      // Step 3 — Verify
      const { verified, phantom, missing } = combinedDiff
        ? await verifyDecisions(consolidated, combinedDiff, llm, commitMessages)
        : { verified: consolidated.map((d) => ({ ...d, status: 'verified' as const, confidence: 'medium' as const })), phantom: [], missing: [] };

      // Step 4 — Persist
      // Reject all original drafts — they've been replaced by consolidated decisions.
      // Also reject any explicitly superseded IDs from prior sessions.
      const originalDraftIds = new Set(drafts.map((d) => d.id));
      const originalById = new Map(store.decisions.map((d) => [d.id, d]));
      // Preserve recordedAt provenance:
      // - Direct match: consolidated decision ID matches original draft → use its recordedAt.
      // - Merged decision (new ID, no match): use earliest recordedAt across all superseded
      //   drafts so the audit trail reflects when the underlying work was first captured.
      const earliestSupersededAt = supersededIds
        .map((id) => originalById.get(id)?.recordedAt)
        .filter((t): t is string => t !== undefined)
        .sort()[0];
      const withProvenance = [...verified, ...phantom].map((d) => {
        const original = originalById.get(d.id);
        if (original) return { ...d, recordedAt: original.recordedAt };
        // Merged decision — anchor to earliest superseded draft's recordedAt
        if (earliestSupersededAt) return { ...d, recordedAt: earliestSupersededAt };
        return d;
      });
      // CAS persist: apply the consolidation result to the FRESHEST store, so a
      // record_decision/approve committed concurrently (different lock) is preserved
      // rather than clobbered by this stale snapshot. replaceDecisions (not upsert)
      // because consolidated decisions share IDs with their original drafts.
      const updatedStore = await updateDecisionStore(rootPath, (s) => {
        let next = s;
        for (const id of [...originalDraftIds, ...supersededIds]) {
          next = patchDecision(next, id, { status: 'rejected' });
        }
        next = replaceDecisions(next, withProvenance);
        return { ...next, lastConsolidatedAt: new Date().toISOString() };
      });

      // Decision autopilot: resolve the freshly-verified decisions without
      // blocking — auto-accept, sync, advisory line, exit 0. (add-decision-autopilot)
      if (options.gate && openloreConfig.governance?.autopilot === true) {
        await runAutopilotGate(rootPath, openloreConfig, options.json);
        return;
      }

      if (options.json) {
        process.stdout.write(JSON.stringify({ verified, phantom, missing }, null, 2) + '\n');
        if (options.gate && missing.length > 0) process.exitCode = 1;
        return;
      }

      // Interactive TUI approval when running in a terminal
      if (options.gate && process.stdin.isTTY && process.stdout.isTTY && verified.length > 0) {
        const results = await runTuiApproval(verified);

        const reviewedAt = new Date().toISOString();
        const tuiPatches: Array<{ id: string; status: 'approved' | 'rejected' }> = [];
        for (const [id, decision] of results) {
          if (decision === 'approved' || decision === 'rejected') {
            tuiPatches.push({ id, status: decision });
            const d = updatedStore.decisions.find((x) => x.id === id);
            emit(rootPath, 'decisions', { event: `decision_${decision}`, id, title: d?.title, transport: 'cli-tui' });
          }
        }
        await updateDecisionStore(rootPath, (s) =>
          tuiPatches.reduce((acc, p) => patchDecision(acc, p.id, {
            status: p.status,
            reviewedAt,
            ...(p.status === 'approved' ? { approvedBy: 'human' as const } : {}),
          }), s), 'human');

        const stillPending = verified.filter(
          (d) => !results.has(d.id) || results.get(d.id) === 'skipped',
        );
        const approved = verified.filter((d) => results.get(d.id) === 'approved');
        const rejected = verified.filter((d) => results.get(d.id) === 'rejected');

        if (approved.length > 0) {
          console.log(`\n${approved.length} decision(s) approved. Run "openlore decisions --sync" to write to spec.md.`);
        }
        if (rejected.length > 0) {
          console.log(`${rejected.length} decision(s) rejected.`);
        }
        if (stillPending.length > 0) {
          logger.warning(`${stillPending.length} decision(s) still pending — commit blocked.`);
          process.exitCode = 1;
        }

        displayMissing(missing);
        if (missing.length > 0) process.exitCode = 1;
        return;
      }

      // Non-TTY (agent/IDE context): structured JSON for ACP consumption
      if (options.gate && !process.stdout.isTTY) {
        const payload = {
          gated: verified.length > 0 || missing.length > 0,
          verified: verified.map((d) => ({
            id: d.id,
            title: d.title,
            rationale: d.rationale,
            consequences: d.consequences,
            proposedRequirement: d.proposedRequirement,
            affectedDomains: d.affectedDomains,
            affectedFiles: d.affectedFiles,
            confidence: d.confidence,
          })),
          phantom: phantom.map((d) => ({ id: d.id, title: d.title })),
          missing: missing.map((m) => ({ file: m.file, description: m.description })),
          actions: {
            approve: 'openlore decisions --approve <id>',
            reject: 'openlore decisions --reject <id>',
            sync: 'openlore decisions --sync',
          },
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        if (payload.gated) process.exitCode = 1;
        return;
      }

      // Plain text recap (non-gate or explicit --list context)
      logger.section('Architectural Decisions — Review Required');

      if (verified.length > 0) {
        console.log('\nVerified decisions (found in code):');
        for (const d of verified) displayDecision(d, options.verbose);
      }

      if (phantom.length > 0) {
        console.log('\nPhantom decisions (recorded but not found in diff — may have been rolled back):');
        for (const d of phantom) displayDecision(d, options.verbose);
      }

      if (verified.length > 0 || phantom.length > 0) printDecisionLegend();

      displayMissing(missing);

      console.log('\nApprove with: openlore decisions --approve <id>');
      console.log('Reject with:  openlore decisions --reject <id>');
      console.log('Sync all approved: openlore decisions --sync');

      if (options.gate && missing.length > 0) {
        logger.warning(`\nCommit gated — ${missing.length} undocumented change(s) require a decision. Record with: openlore decisions --record or record_decision MCP tool.`);
        process.exitCode = 1;
      } else if (options.gate && verified.length > 0) {
        logger.warning('\nDecisions verified — approve them before syncing: openlore decisions --approve <id>');
        process.exitCode = 1;
      }
      return;
      } finally {
        await releaseConsolidateLock();
      }
    }

    // ── Gate only (no consolidation — consolidation happens on record_decision) ──
    if (options.gate && !options.consolidate) {
      // Decision autopilot: accept + sync + trail, never block. (add-decision-autopilot)
      const gateConfig = await readOpenLoreConfig(rootPath);
      if (gateConfig?.governance?.autopilot === true) {
        await runAutopilotGate(rootPath, gateConfig, options.json);
        return;
      }
      const approved = getDecisionsByStatus(store, 'approved');
      const verified = getDecisionsByStatus(store, 'verified');
      const drafts = getDecisionsByStatus(store, 'draft');
      const missing: Array<{ file: string; description: string }> = [];

      // Phantom decisions ("recorded but no code evidence") are excluded — stale
      // phantoms from previous sessions would otherwise silently bypass the gate.
      const activeCount = store.decisions.filter((d) => !INACTIVE_STATUSES.has(d.status)).length;
      const consolidatedRecently = !!store.lastConsolidatedAt
        && (Date.now() - new Date(store.lastConsolidatedAt).getTime()) < CONSOLIDATION_GRACE_PERIOD_MS;

      // The staged-source check is the only input requiring git; resolve it lazily,
      // only in the state where it can change the outcome (nothing else gates).
      let isGitRepo = false;
      let hasStagedSourceChanges = false;
      if (approved.length === 0 && verified.length === 0 && drafts.length === 0
          && !consolidatedRecently && activeCount === 0) {
        isGitRepo = await isGitRepository(rootPath);
        if (isGitRepo) {
          try {
            const { stdout } = await execFileAsync(
              'git', ['diff', '--cached', '--name-only', '--diff-filter=ACDMR'],
              { cwd: rootPath },
            );
            const stagedFiles = stdout.trim().split('\n').filter(Boolean);
            const SOURCE_EXTS = /\.(ts|js|tsx|jsx|py|go|rs|rb|java|cpp|cc|swift)$/;
            hasStagedSourceChanges = stagedFiles.some((f) => SOURCE_EXTS.test(f));
          } catch { /* git unavailable — skip */ }
        }
      }

      // The pure reason machine is the single arbiter of which reason applies.
      const outcome = classifyGateState({
        approvedCount: approved.length,
        verifiedCount: verified.length,
        draftCount: drafts.length,
        consolidatedRecently,
        activeCount,
        isGitRepo,
        hasStagedSourceChanges,
      });

      if (outcome.reason === GATE_REASONS.APPROVED_NOT_SYNCED) {
        const payload = {
          gated: true,
          reason: GATE_REASONS.APPROVED_NOT_SYNCED,
          message: `${approved.length} approved decision(s) must be synced to spec files before committing.`,
          approved: approved.map((d) => ({ id: d.id, title: d.title })),
          actions: { sync: 'openlore decisions --sync' },
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        process.exitCode = 1;
        return;
      }

      if (outcome.reason === GATE_REASONS.DRAFTS_PENDING_CONSOLIDATION) {
        // Drafts recorded but consolidation never completed.
        // Output structured JSON so the agent can relay to the user and act on the answer.
        const payload = {
          gated: true,
          reason: GATE_REASONS.DRAFTS_PENDING_CONSOLIDATION,
          message: `${drafts.length} draft decision(s) were recorded but never consolidated.`,
          drafts: drafts.map((d) => ({ id: d.id, title: d.title, recordedAt: d.recordedAt })),
          actions: {
            consolidate: 'openlore decisions --consolidate',
            consolidateAndGate: 'openlore decisions --consolidate --gate',
            skip: 'git commit --no-verify',
          },
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        process.exitCode = 1;
        return;
      }

      if (outcome.reason === GATE_REASONS.NO_DECISIONS_RECORDED) {
        // Source files staged but nothing recorded — output JSON for agent to relay.
        const payload = {
          gated: true,
          reason: GATE_REASONS.NO_DECISIONS_RECORDED,
          message: 'Source files are staged but no architectural decisions were recorded.',
          actions: {
            consolidateAndGate: 'openlore decisions --consolidate --gate',
            skip: 'git commit --no-verify',
          },
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        process.exitCode = 1;
        return;
      }

      if (!outcome.gated) {
        // Clean commit — nothing to review.
        process.exitCode = 0;
        return;
      }

      // outcome.reason === GATE_REASONS.VERIFIED — verified decisions await review.
      // TTY: interactive TUI
      if (process.stdin.isTTY && process.stdout.isTTY && verified.length > 0) {
        const results = await runTuiApproval(verified);
        const reviewedAt = new Date().toISOString();
        const tuiPatches: Array<{ id: string; status: 'approved' | 'rejected' }> = [];
        for (const [id, decision] of results) {
          if (decision === 'approved' || decision === 'rejected') {
            tuiPatches.push({ id, status: decision });
          }
        }
        await updateDecisionStore(rootPath, (s) =>
          tuiPatches.reduce((acc, p) => patchDecision(acc, p.id, {
            status: p.status,
            reviewedAt,
            ...(p.status === 'approved' ? { approvedBy: 'human' as const } : {}),
          }), s), 'human');
        const stillPending = verified.filter(
          (d) => !results.has(d.id) || results.get(d.id) === 'skipped',
        );
        if (stillPending.length > 0) process.exitCode = 1;
        return;
      }

      // Non-TTY: JSON for ACP/agent consumption
      const payload = {
        gated: true,
        reason: GATE_REASONS.VERIFIED,
        verified: verified.map((d) => ({
          id: d.id,
          title: d.title,
          rationale: d.rationale,
          consequences: d.consequences,
          proposedRequirement: d.proposedRequirement,
          affectedDomains: d.affectedDomains,
          affectedFiles: d.affectedFiles,
          confidence: d.confidence,
        })),
        phantom: [],
        missing,
        actions: {
          approve: 'openlore decisions --approve <id>',
          reject: 'openlore decisions --reject <id>',
          sync: 'openlore decisions --sync',
        },
      };
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      process.exitCode = 1;
      return;
    }

    // ── Sync ─────────────────────────────────────────────────────────────────
    if (options.sync) {
      const openloreConfig = await readOpenLoreConfig(rootPath);
      if (!openloreConfig) {
        logger.error('No openlore configuration found.');
        process.exitCode = 1;
        return;
      }

      const openspecPath = join(rootPath, openloreConfig.openspecPath ?? OPENSPEC_DIR);
      const specsPath = join(openspecPath, OPENSPEC_SPECS_SUBDIR);
      if (!(await fileExists(specsPath))) {
        logger.error('No specs found. Run "openlore generate" first.');
        process.exitCode = 1;
        return;
      }

      const specMap = await buildSpecMap({ rootPath, openspecPath });
      const approved = getDecisionsByStatus(store, 'approved');

      if (approved.length === 0 && !options.json) {
        console.log('No approved decisions to sync. Use --approve <id> first.');
      }

      if (approved.length > 0 && !options.json) {
        logger.discovery(`Syncing ${approved.length} approved decision(s)...`);
      }

      // Always call syncApprovedDecisions so purgeInactiveDecisions runs on the store
      // even when there are no approved decisions to sync.
      const { result } = await syncApprovedDecisions(store, {
        rootPath,
        openspecPath,
        specMap,
        dryRun: options.dryRun,
      });
      emit(rootPath, 'decisions', { event: 'decisions_synced', count: result.synced.length, dry_run: options.dryRun, transport: 'cli' });

      // A partial sync must exit non-zero: the documented gate workflow ("run
      // `openlore decisions --sync`, then retry `git commit`") relies on this to not
      // proceed on a failed sync. Applies to both json and text output.
      if (result.errors.length > 0) process.exitCode = 1;

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }

      for (const d of result.synced) {
        logger.success(`✔ Synced [${d.id}] ${d.title}`);
        for (const p of d.syncedToSpecs) console.log(`   → ${p}`);
      }
      for (const e of result.errors) {
        logger.error(`✗ [${e.id}] ${e.error}`);
      }
      if (options.dryRun) console.log('\n(dry-run — no files were written)');
      return;
    }

    // ── Default: list ────────────────────────────────────────────────────────
    const VALID_STATUSES = new Set(['draft', 'consolidated', 'verified', 'phantom', 'approved', 'auto-approved', 'rejected', 'synced']);
    if (options.status && !VALID_STATUSES.has(options.status)) {
      logger.error(`Invalid status "${options.status}". Valid values: ${[...VALID_STATUSES].join('|')}`);
      process.exitCode = 1;
      return;
    }
    const all = options.status
      ? store.decisions.filter((d) => d.status === options.status)
      : store.decisions;

    if (options.json) {
      process.stdout.write(JSON.stringify(all, null, 2) + '\n');
      return;
    }

    if (all.length === 0) {
      console.log('No decisions recorded yet. Agents can call the record_decision MCP tool during development.');
      return;
    }

    logger.section('Architectural Decisions');
    for (const d of all) displayDecision(d, options.verbose);
    printDecisionLegend();
    console.log(`\nTotal: ${all.length}`);
    } catch (err) {
      logger.error(`decisions command failed: ${(err as Error).message}`);
      if (process.env.DEBUG) console.error(err);
      process.exitCode = 1;
    } finally {
      restoreStdout?.();
    }
  });

// ============================================================================
// SUBCOMMANDS: log · review (change: add-decision-autopilot)
// ============================================================================

/** Resolve a `--since` value to an epoch ms cutoff: ISO date, or a git ref's commit time. */
async function resolveSinceCutoff(rootPath: string, since: string): Promise<number> {
  const asDate = Date.parse(since);
  if (!Number.isNaN(asDate)) return asDate;
  const { stdout } = await execFileAsync('git', ['show', '-s', '--format=%cI', since], { cwd: rootPath });
  const t = Date.parse(stdout.trim().split('\n').pop() ?? '');
  if (Number.isNaN(t)) throw new Error(`--since "${since}" is neither an ISO date nor a resolvable git ref`);
  return t;
}

decisionsCommand
  .command('log')
  .description('Show the append-only decision transition ledger (newest first)')
  .option('--json', 'Output as JSON', false)
  .option('--since <ref>', 'Only entries after this ISO date or git ref (commit time)')
  .action(async (opts: { json: boolean; since?: string }, cmd: Command) => {
    // The parent `decisions` command declares same-named options (--json) and,
    // without positional-option mode, commander parses them greedily out of the
    // subcommand argv — merge them back so `decisions log --json` works.
    const parentOpts = (cmd.parent?.opts() ?? {}) as { json?: boolean };
    const json = Boolean(opts.json || parentOpts.json);
    const restoreStdout = json ? redirectConsoleToStderr() : null;
    try {
      const rootPath = process.cwd();
      let entries = await readLedger(rootPath);
      if (opts.since) {
        const cutoff = await resolveSinceCutoff(rootPath, opts.since);
        entries = entries.filter((e) => Date.parse(e.at) >= cutoff);
      }
      entries.reverse(); // newest first

      if (json) {
        process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
        return;
      }
      if (entries.length === 0) {
        console.log('Decision ledger is empty — no transitions recorded yet.');
        return;
      }
      logger.section('Decision Ledger (newest first)');
      for (const e of entries) {
        const when = e.at.replace('T', ' ').slice(0, 19);
        const commit = e.commit ? ` @${e.commit}` : '';
        console.log(`${when}  [${e.id}] ${e.from ?? '∅'} → ${e.to}  by ${e.actor}${commit}  ${e.title}`);
      }
      console.log(`\nTotal: ${entries.length} transition(s)`);
    } catch (err) {
      logger.error(`decisions log failed: ${(err as Error).message}`);
      process.exitCode = 1;
    } finally {
      restoreStdout?.();
    }
  });

/** Parse a `--promote/--reject` id list ("all" or comma-separated 8-char ids) against the queue. */
function resolveReviewIds(raw: string, queue: PendingDecision[]): string[] {
  if (raw.trim().toLowerCase() === 'all') return queue.map((d) => d.id);
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const queueIds = new Set(queue.map((d) => d.id));
  const unknown = ids.filter((id) => !queueIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`not in the auto-accepted review queue: ${unknown.join(', ')} (see: openlore decisions review)`);
  }
  return ids;
}

decisionsCommand
  .command('review')
  .description('List auto-accepted (unreviewed) decisions; --promote or --reject them')
  .option('--promote <ids>', 'Comma-separated ids, or "all": confirm as human-approved (drops the unreviewed marker)')
  .option('--reject <ids>', 'Comma-separated ids, or "all": reject and retire from specs (kept queryable in history)')
  .option('--note <text>', 'Review note to attach')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { promote?: string; reject?: string; note?: string; json: boolean }, cmd: Command) => {
    // The parent `decisions` command declares same-named options (--reject,
    // --note, --json) and, without positional-option mode, commander parses
    // them greedily out of the subcommand argv — merge them back so
    // `decisions review --reject <ids>` reaches this action.
    const parentOpts = (cmd.parent?.opts() ?? {}) as { reject?: string; note?: string; json?: boolean };
    const promoteRaw = opts.promote;
    const rejectRaw = opts.reject ?? parentOpts.reject;
    const note = opts.note ?? parentOpts.note;
    const json = Boolean(opts.json || parentOpts.json);
    const restoreStdout = json ? redirectConsoleToStderr() : null;
    try {
      const rootPath = process.cwd();
      const store = await loadDecisionStore(rootPath);
      const queue = store.decisions.filter((d) => d.status === 'auto-approved' && !d.humanReviewedAt);

      if (promoteRaw && rejectRaw) {
        // Same id in both would be ambiguous; require distinct sets.
        const overlap = resolveReviewIds(promoteRaw, queue).filter((id) =>
          resolveReviewIds(rejectRaw, queue).includes(id));
        if (overlap.length > 0) {
          logger.error(`ids in both --promote and --reject: ${overlap.join(', ')}`);
          process.exitCode = 1;
          return;
        }
      }

      const now = new Date().toISOString();
      const results: Array<{ id: string; title: string; disposition: 'promoted' | 'rejected'; specsUpdated: string[] }> = [];

      for (const [raw, disposition] of [[promoteRaw, 'promoted'], [rejectRaw, 'rejected']] as const) {
        if (!raw) continue;
        const ids = resolveReviewIds(raw, queue);
        for (const id of ids) {
          const decision = queue.find((d) => d.id === id)!;
          await updateDecisionStore(rootPath, (s) => {
            const cur = s.decisions.find((d) => d.id === id);
            // Legality: only a still-unreviewed auto-approved decision transitions.
            if (!cur || cur.status !== 'auto-approved' || cur.humanReviewedAt) return s;
            return patchDecision(s, id, {
              status: disposition === 'promoted' ? 'synced' : 'rejected',
              humanReviewedAt: now,
              reviewedAt: now,
              ...(note ? { reviewNote: note } : {}),
            });
          }, 'human');
          const specsUpdated = await rewriteSyncedDecisionStatus(rootPath, decision, disposition);
          emit(rootPath, 'decisions', {
            event: disposition === 'promoted' ? 'decision_review_promoted' : 'decision_review_rejected',
            id, title: decision.title, transport: 'cli-review',
          });
          results.push({ id, title: decision.title, disposition, specsUpdated });
        }
      }

      const fresh = await loadDecisionStore(rootPath);
      const remaining = fresh.decisions.filter((d) => d.status === 'auto-approved' && !d.humanReviewedAt);

      if (json) {
        process.stdout.write(JSON.stringify({
          reviewed: results,
          awaitingReview: remaining.map((d) => ({
            id: d.id, title: d.title, rationale: d.rationale,
            reviewedAt: d.reviewedAt, syncedToSpecs: d.syncedToSpecs,
          })),
        }, null, 2) + '\n');
        return;
      }

      for (const r of results) {
        const verb = r.disposition === 'promoted' ? 'promoted to Approved' : 'rejected (retired from specs)';
        logger.success(`[${r.id}] ${verb} — ${r.title}`);
        for (const p of r.specsUpdated) console.log(`   → ${p}`);
      }
      if (remaining.length === 0) {
        console.log(results.length > 0 ? '\nReview queue is empty.' : 'No auto-accepted decisions await review.');
        return;
      }
      logger.section('Auto-accepted decisions awaiting review');
      for (const d of remaining) displayDecision(d, true);
      console.log(`\nPromote: openlore decisions review --promote <id,id|all>`);
      console.log(`Reject:  openlore decisions review --reject <id,id|all>`);
    } catch (err) {
      logger.error(`decisions review failed: ${(err as Error).message}`);
      process.exitCode = 1;
    } finally {
      restoreStdout?.();
    }
  });
