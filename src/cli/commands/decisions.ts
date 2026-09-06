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
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { confinedAtomicWriteFile, safeJoin } from '../../utils/path-confinement.js';

import { logger } from '../../utils/logger.js';
import { resolveTrustedApiBase, resolveTrustedSslVerify } from '../../core/services/repo-config-trust.js';
import { colorForStdout } from '../../utils/colors.js';
import { gitPathArgs } from '../../utils/git-args.js';
import { redirectConsoleToStderr } from '../../utils/quiet-stdout.js';
import { fileExists, resolveLLMProvider } from '../../utils/command-helpers.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { createLLMService } from '../../core/services/llm-service.js';
import { isLlmLoggingEnabled } from '../../core/services/llm-logging-policy.js';
import { isGitRepositoryRoot, getChangedFiles, getFileDiff, getCommitMessages, resolveBaseRef, buildSpecMap, validateGitRef } from '../../core/drift/index.js';
import {
  loadDecisionStore,
  updateDecisionStore,
  patchDecision,
  getDecisionsByStatus,
  INACTIVE_STATUSES,
  illegalPromotionToApproved,
} from '../../core/decisions/store.js';
import { readLedger } from '../../core/decisions/ledger.js';
import { loadDecisionConstraintState } from '../../core/decisions/constraint-ledger.js';
import { rewriteSyncedDecisionStatus } from '../../core/decisions/syncer.js';
import { consolidateDrafts } from '../../core/decisions/consolidator.js';
import {
  DECISION_DISPOSITION_REASONS,
  applyConsolidationOutcome,
  describeDisposition,
  readDisposition,
  withVerificationOutcome,
  type DraftDisposition,
} from '../../core/decisions/disposition.js';
import { classifyGateState, matchesConsolidationReceipt } from '../../core/decisions/gate-state.js';
import { acquireDecisionsLock } from '../../core/runtime/advisory-lock.js';
import { extractFromDiff } from '../../core/decisions/extractor.js';
import { markVerificationEvidenceAbsent, verifyDecisions } from '../../core/decisions/verifier.js';
import { syncApprovedDecisions } from '../../core/decisions/syncer.js';
import {
  OPENLORE_DIR,
  OPENLORE_LOGS_SUBDIR,
  OPENSPEC_SPECS_SUBDIR,
  DECISIONS_EXTRACTION_MAX_FILES,
  DECISIONS_DIFF_MAX_CHARS,
  CONSOLIDATION_GRACE_PERIOD_MS,
  GATE_REASONS,
} from '../../constants.js';
import type { DecisionStore, PendingDecision } from '../../types/index.js';
import { runTuiApproval } from '../tui-approval.js';
import { emit } from '../../core/services/telemetry.js';
import { resolveOpenspecDir } from '../../utils/openspec-dir.js';
import { execFileGit as execFileAsync } from '../../utils/git-exec.js';
import {
  displayHookPath,
  hookManagerWarning,
  isResolvedGitRepository,
  resolveGitHookTarget,
  resolveGitPath,
  resolveTrustedHookLauncher,
  renderTrustedHookCommand,
  updateHookFile,
} from '../git-hooks.js';

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
async function injectAgentInstructions(rootPath: string, filePath: string): Promise<'injected' | 'already' | 'missing'> {
  if (!(await fileExists(filePath))) return 'missing';
  const content = await readFile(filePath, 'utf-8');
  if (content.includes(AGENT_INSTRUCTIONS_MARKER)) return 'already';
  await confinedAtomicWriteFile(rootPath, filePath, content.trimEnd() + '\n\n' + AGENT_INSTRUCTIONS_BLOCK, { preserveMode: true });
  return 'injected';
}

/** Remove decisions instructions block from an agent file. */
async function removeAgentInstructions(rootPath: string, filePath: string): Promise<void> {
  if (!(await fileExists(filePath))) return;
  const content = await readFile(filePath, 'utf-8');
  if (!content.includes(AGENT_INSTRUCTIONS_MARKER)) return;
  const cleaned = content
    .replace(/\n*<!-- openlore-decisions-instructions -->[\s\S]*?<!-- end-openlore-decisions-instructions -->\n*/g, '')
    .trim();
  await confinedAtomicWriteFile(rootPath, filePath, cleaned + '\n', { preserveMode: true });
}

// ============================================================================
// HOOK MANAGEMENT
// ============================================================================

const HOOK_MARKER = '# openlore-decisions-hook';
const SOURCE_EXTS = /\.(ts|js|tsx|jsx|py|go|rs|rb|java|cpp|cc|swift)$/;

async function sourceSnapshotFingerprint(
  rootPath: string,
  staged: boolean,
): Promise<{ fingerprint: string; hasSourceChanges: boolean } | null> {
  try {
    const diffArgs = staged
      ? gitPathArgs('diff', '--cached', '--name-only', '--diff-filter=ACDMR', '-z')
      : gitPathArgs('diff', '--name-only', '--diff-filter=ACDMR', '-z', 'HEAD');
    const { stdout } = await execFileAsync('git', diffArgs, { cwd: rootPath });
    const paths = stdout.split('\0').filter((path) => SOURCE_EXTS.test(path));
    if (!staged) {
      const { stdout: untracked } = await execFileAsync(
        'git', gitPathArgs('ls-files', '--others', '--exclude-standard', '-z'),
        { cwd: rootPath },
      );
      paths.push(...untracked.split('\0').filter((path) => SOURCE_EXTS.test(path)));
    }

    const entries: Array<[string, string]> = [];
    for (const path of [...new Set(paths)].sort()) {
      let objectId = 'deleted';
      try {
        if (staged) {
          const { stdout: stagedEntry } = await execFileAsync(
            'git', gitPathArgs('ls-files', '--stage', '--', path),
            { cwd: rootPath },
          );
          objectId = stagedEntry.trim().split(/\s+/)[1] ?? 'deleted';
        } else {
          const { stdout: worktreeHash } = await execFileAsync(
            'git', gitPathArgs('hash-object', '--', path),
            { cwd: rootPath },
          );
          objectId = worktreeHash.trim();
        }
      } catch {
        // A changed path absent from the selected snapshot is a deletion.
      }
      entries.push([path, objectId]);
    }
    return {
      fingerprint: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      hasSourceChanges: entries.length > 0,
    };
  } catch {
    return null;
  }
}

function renderHookContent(invocation: string): string {
  return `${HOOK_MARKER}
# Gate commits until architectural decisions are reviewed.
# Installed by: openlore setup --tools claude

# Pin the trusted installation that created this hook. Never execute mutable
# node_modules/dist content from the repository being committed.
${invocation} 2>&1
DECISIONS_EXIT=$?
if [ "$DECISIONS_EXIT" -ne 0 ]; then
  exit "$DECISIONS_EXIT"
fi
# Sentinel written on successful gate pass. Post-commit checks for its absence to detect --no-verify bypass.
touch "$(git rev-parse --git-dir 2>/dev/null || echo .git)/OPENLORE_GATE_RAN" 2>/dev/null || true
# end-openlore-decisions-hook
`;
}

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
  const gitignorePath = safeJoin(rootPath, '.gitignore');
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
  await confinedAtomicWriteFile(rootPath, gitignorePath, content.trimEnd() + '\n' + entry + '\n', { preserveMode: true });
  logger.discovery(`  → added ${entry} to .gitignore`);
}

async function ensureDecisionSupportFiles(rootPath: string): Promise<void> {
  await ensureGitignored(rootPath, '.openlore/decisions/');
  const agentFiles = [
    { path: safeJoin(rootPath, 'CLAUDE.md'), label: 'CLAUDE.md' },
    { path: safeJoin(rootPath, 'AGENTS.md'), label: 'AGENTS.md' },
    { path: safeJoin(rootPath, '.cursorrules'), label: '.cursorrules' },
    { path: safeJoin(rootPath, '.clinerules/openlore.md'), label: '.clinerules/openlore.md' },
    { path: safeJoin(rootPath, '.github/copilot-instructions.md'), label: '.github/copilot-instructions.md' },
    { path: safeJoin(rootPath, '.windsurf/rules.md'), label: '.windsurf/rules.md' },
    { path: safeJoin(rootPath, '.vibe/skills/openlore.md'), label: '.vibe/skills/openlore.md' },
  ];
  for (const { path: filePath, label } of agentFiles) {
    const result = await injectAgentInstructions(rootPath, filePath);
    if (result === 'injected') logger.discovery(`  → record_decision instructions added to ${label}`);
  }
}

export async function runPostCommitDecisionCheck(rootPath: string): Promise<void> {
  const sentinel = await resolveGitPath(rootPath, 'OPENLORE_GATE_RAN')
    ?? join(rootPath, '.git', 'OPENLORE_GATE_RAN');
  if (await fileExists(sentinel)) {
    await rm(sentinel, { force: true });
    return;
  }
  logger.warning('openlore: pre-commit gate was bypassed (--no-verify). Architectural decisions were not reviewed for this commit. Run: openlore decisions --consolidate --gate');
}

/**
 * Does this repository already carry an OpenLore decisions commit gate?
 *
 * Read by `openlore install` so it never changes the mode of a gate someone else
 * configured: an absent `governance.autopilot` means blocking review, so writing
 * the non-blocking default over an EXISTING gate would silently downgrade it
 * (change: unify-onboarding-entrypoint).
 */
export async function hasOpenLoreCommitGate(rootPath: string): Promise<boolean> {
  try {
    const { hookPath } = await resolveGitHookTarget(rootPath, 'pre-commit');
    return (await readFile(hookPath, 'utf-8')).includes(HOOK_MARKER);
  } catch {
    return false; // no hook, or unreadable — either way, no gate we must preserve
  }
}

export async function installPreCommitHook(
  rootPath: string,
  /**
   * How the gate will behave once installed. In `autopilot` mode the gate records
   * and syncs verified decisions and never blocks a commit, so the blocking notice
   * below would be flatly untrue — and it was being printed one line above
   * `openlore install`'s own "no commit is blocked by default"
   * (change: unify-onboarding-entrypoint).
   */
  opts: { autopilot?: boolean } = {},
): Promise<boolean> {
  const target = await resolveGitHookTarget(rootPath, 'pre-commit');
  const hookPath = target.hookPath;

  if (!(await isResolvedGitRepository(rootPath, target))) {
    logger.error('Not a git repository. Cannot install hook.');
    process.exitCode = 1;
    return false;
  }
  const launcher = await resolveTrustedHookLauncher(rootPath);
  if (!launcher) {
    logger.error('Refusing to install a security hook that executes mutable code from this repository. Install OpenLore globally and retry.');
    process.exitCode = 1;
    return false;
  }
  const hookContent = renderHookContent(renderTrustedHookCommand(launcher, ['decisions', '--gate']));
  await ensureDecisionSupportFiles(rootPath);
  if (!target.canInstall) {
    logger.warning(hookManagerWarning(target, 'openlore decisions --gate'));
    const postTarget = await resolveGitHookTarget(rootPath, 'post-commit');
    logger.warning(hookManagerWarning(postTarget, 'openlore decisions --post-commit-check'));
    return false;
  }

  let preAlreadyInstalled = false;
  let appendedPre = false;
  const preResult = await updateHookFile(hookPath, (existing) => {
    if (existing?.includes(HOOK_MARKER)) {
      const refreshed = existing.replace(
        /# openlore-decisions-hook[\s\S]*?# end-openlore-decisions-hook/,
        hookContent.trimEnd(),
      );
      preAlreadyInstalled = refreshed === existing;
      return preAlreadyInstalled ? null : refreshed;
    }
    appendedPre = existing !== null;
    const stripped = existing
      ?.replace(/\n*# spec-gen-decisions-hook[\s\S]*?# end-spec-gen-decisions-hook\n*/g, '')
      .trimEnd()
      .replace(/\n*\nexit 0\s*$/, '');
    return stripped
      ? stripped + '\n\n' + hookContent
      : '#!/bin/sh\n\n' + hookContent;
  });
  if (preResult.status === 'unavailable') {
    logger.warning(`Cannot install the decisions hook at ${displayHookPath(hookPath)}: ${preResult.reason}`);
    return false;
  }
  if (preAlreadyInstalled) logger.success('Pre-commit hook already installed.');
  else {
    if (appendedPre) logger.discovery('Existing pre-commit hook found. Appending decisions gate.');
    logger.success(`Pre-commit hook installed at ${displayHookPath(hookPath)}`);
    logger.discovery(opts.autopilot
      ? 'Verified decisions are recorded and synced at commit time. No commit is blocked.'
      : 'Commits will be gated until decisions are approved. Use --no-verify to skip.');
  }

  // Install post-commit hook to detect --no-verify bypass
  const postTarget = await resolveGitHookTarget(rootPath, 'post-commit');
  const postCommitPath = postTarget.hookPath;
  if (!postTarget.canInstall) {
    logger.warning(hookManagerWarning(postTarget, 'openlore decisions --post-commit-check'));
    // The gate itself IS installed; only its bypass detector is not.
    return true;
  }
  const postResult = await updateHookFile(postCommitPath, (existing) => {
    if (existing?.includes(POST_COMMIT_HOOK_MARKER)) return null;
    const stripped = existing?.trimEnd().replace(/\n*\nexit 0\s*$/, '');
    return stripped
      ? stripped + '\n\n' + POST_COMMIT_HOOK_CONTENT
      : '#!/bin/sh\n\n' + POST_COMMIT_HOOK_CONTENT;
  });
  if (postResult.status === 'unavailable') {
    logger.warning(`Cannot install the decisions post-commit hook at ${displayHookPath(postCommitPath)}: ${postResult.reason}`);
    return true;
  }
  logger.success(`Post-commit hook installed at ${displayHookPath(postCommitPath)} (bypass detector)`);
  return true;
}

export async function uninstallPreCommitHook(rootPath: string): Promise<void> {
  const { hookPath } = await resolveGitHookTarget(rootPath, 'pre-commit');
  let preFound = false;
  let preBlockFound = false;
  let preDeleted = false;
  const preResult = await updateHookFile(hookPath, (existing) => {
    if (existing === null) return null;
    preFound = true;
    if (!existing.includes(HOOK_MARKER)) return null;
    preBlockFound = true;
    const cleaned = existing
      .replace(/\n*# openlore-decisions-hook[\s\S]*?# end-openlore-decisions-hook\n*/g, '')
      .replace(/\n*# spec-gen-decisions-hook[\s\S]*?# end-spec-gen-decisions-hook\n*/g, '')
      .trim();
    if (!cleaned || cleaned === '#!/bin/sh') {
      preDeleted = true;
      return undefined;
    }
    return cleaned + '\n';
  });
  if (preResult.status === 'unavailable') {
    logger.warning(`Cannot uninstall the decisions hook at ${displayHookPath(hookPath)}: ${preResult.reason}`);
  } else if (!preFound) {
    logger.warning('No pre-commit hook found.');
  } else if (!preBlockFound) {
    logger.warning('Pre-commit hook does not contain openlore decisions gate.');
  } else if (preDeleted) {
    logger.success('Pre-commit hook removed (file deleted — was only openlore).');
  } else {
    logger.success('OpenLore decisions gate removed from pre-commit hook.');
  }

  // Remove post-commit bypass detector
  const { hookPath: postCommitPath } = await resolveGitHookTarget(rootPath, 'post-commit');
  let postRemoved = false;
  let postDeleted = false;
  const postResult = await updateHookFile(postCommitPath, (existing) => {
    if (!existing?.includes(POST_COMMIT_HOOK_MARKER)) return null;
    postRemoved = true;
    const cleaned = existing
      .replace(/\n*# openlore-decisions-post-hook[\s\S]*?# end-openlore-decisions-post-hook\n*/g, '')
      .trim();
    if (!cleaned || cleaned === '#!/bin/sh') {
      postDeleted = true;
      return undefined;
    }
    return cleaned + '\n';
  });
  if (postResult.status === 'unavailable') {
    logger.warning(`Cannot uninstall the decisions post-commit hook at ${displayHookPath(postCommitPath)}: ${postResult.reason}`);
  } else if (postRemoved) {
    logger.success(postDeleted ? 'Post-commit hook removed.' : 'OpenLore bypass detector removed from post-commit hook.');
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
  for (const filePath of agentFiles) await removeAgentInstructions(rootPath, filePath);
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
export async function runAutopilotGate(
  rootPath: string,
  config: NonNullable<Awaited<ReturnType<typeof readOpenLoreConfig>>>,
  jsonMode: boolean,
  unassessed: readonly PendingDecision[] = [],
): Promise<void> {
  try {
    let store = await loadDecisionStore(rootPath);
    const verified = getDecisionsByStatus(store, 'verified');
    const verifiedIds = verified.filter((d) => d.verificationEvidence !== 'none').map((d) => d.id);
    const unevidencedCount = verified.length - verifiedIds.length;

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
      const openspecPath = resolveOpenspecDir(rootPath, config.openspecPath);
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
    const unassessedDrafts = unassessed.filter((decision) => decision.status === 'draft');
    const concurrentlyResolved = unassessed.length - unassessedDrafts.length;
    if (unassessedDrafts.length > 0) parts.push(`${unassessedDrafts.length} unassessed decision(s) retained as drafts`);
    if (concurrentlyResolved > 0) parts.push(`${concurrentlyResolved} unassessed decision(s) resolved concurrently`);
    if (draftCount > 0) parts.push(`${draftCount} draft(s) pending background consolidation`);
    if (syncErrors.length > 0) parts.push(`${syncErrors.length} sync error(s) — will retry next gate`);
    if (unevidencedCount > 0) parts.push(`${unevidencedCount} unevidenced decision(s) require review`);
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
        unassessed: unassessed.map((decision) => ({
          id: decision.id,
          title: decision.title,
          status: decision.status,
        })),
        draftsPending: draftCount,
        awaitingReview: unreviewedCount,
        unevidencedAwaitingReview: unevidencedCount,
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

export function reconcileDecisionClassifications(
  store: DecisionStore,
  classifications: {
    verified: readonly PendingDecision[];
    phantom: readonly PendingDecision[];
    unassessed: readonly PendingDecision[];
  },
): { verified: PendingDecision[]; phantom: PendingDecision[]; unassessed: PendingDecision[] } {
  const committed = new Map(store.decisions.map((decision) => [decision.id, decision]));
  const reconcile = (decisions: readonly PendingDecision[]) =>
    decisions.map((decision) => committed.get(decision.id) ?? decision);
  return {
    verified: reconcile(classifications.verified),
    phantom: reconcile(classifications.phantom),
    unassessed: reconcile(classifications.unassessed),
  };
}

export function classificationsBlockGate(
  classifications: {
    verified: readonly PendingDecision[];
    phantom?: readonly PendingDecision[];
    unassessed: readonly PendingDecision[];
  },
  missingCount: number,
): boolean {
  return missingCount > 0
    || classifications.verified.some(decisionClassificationIsUnresolved)
    || (classifications.phantom ?? []).some(decisionClassificationIsUnresolved)
    || classifications.unassessed.some(decisionClassificationIsUnresolved);
}

export function decisionClassificationIsUnresolved(decision: PendingDecision): boolean {
  return decision.status === 'draft'
    || decision.status === 'consolidated'
    || decision.status === 'verified'
    || decision.status === 'approved';
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
  const safeScopeLabel = safe(scopeLabel);
  const scopeBadge =
    scopeLabel === 'system'       ? c.red(`[${safeScopeLabel}]`) :
    scopeLabel === 'cross-domain' ? c.yellow(`[${safeScopeLabel}]`) :
    scopeLabel === 'component'    ? c.blue(`[${safeScopeLabel}]`) :
                                    c.gray(`[${safeScopeLabel}]`);

  console.log(`${icon} [${safe(d.id)}] ${scopeBadge} ${safe(d.title)}`);
  const originLabel = d.contentOrigin === 'llm-extracted'
    ? 'LLM-extracted'
    : d.contentOrigin === 'agent-recorded' ? 'agent-recorded' : 'legacy/unknown';
  console.log(`   Content origin: ${originLabel}`);
  if (d.contentOrigin === 'llm-extracted') {
    console.log(c.yellow('   ⚠ LLM-extracted from repository content; review all text before approval.'));
  }
  if (verbose) {
    console.log(`   Status     : ${safe(d.status)}  Confidence: ${confidence}  Scope: ${safeScopeLabel}`);
    console.log(`   Verification evidence: ${d.verificationEvidence ?? 'legacy/unknown'}`);
    console.log(`   Rationale  : ${safe(d.rationale)}`);
    if (d.affectedDomains.length) console.log(`   Domains    : ${safe(d.affectedDomains.join(', '))}`);
    if (d.proposedRequirement) console.log(`   Requirement: ${safe(d.proposedRequirement)}`);
    if (d.evidenceFile) console.log(`   Evidence   : ${safe(d.evidenceFile)}`);
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
  .option('--post-commit-check', 'Report when the decisions pre-commit gate was bypassed', false)
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
    postCommitCheck: boolean;
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
    if (options.postCommitCheck) {
      await runPostCommitDecisionCheck(rootPath);
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
      // Transition guard: refuse promoting a rejected (or already-synced)
      // decision to approved — a recorded human verdict is never reversed as a
      // side-effect; the human must re-record to reverse it explicitly.
      const illegalApprove = illegalPromotionToApproved(id, decision.status, decision.reviewNote);
      if (illegalApprove) {
        logger.error(illegalApprove);
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
          const openspecPath = resolveOpenspecDir(rootPath, openloreConfig.openspecPath);
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
        apiBase: resolveTrustedApiBase(globalOpts.apiBase, openloreConfig?.llm?.apiBase),
        sslVerify: resolveTrustedSslVerify(globalOpts.insecure, openloreConfig?.llm?.sslVerify),
        enableLogging: isLlmLoggingEnabled(),
        logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
        logRoot: rootPath,
      });

      // Step 1 — Consolidate drafts OR extract from diff as fallback
      const openspecPath = resolveOpenspecDir(rootPath, openloreConfig.openspecPath);
      const specMapResult = await buildSpecMap({ rootPath, openspecPath }).catch(() => undefined);
      let consolidated: PendingDecision[];
      let supersededIds: string[] = [];
      let dispositions: DraftDisposition[] = [];
      if (hasDrafts) {
        if (!options.json) logger.discovery(`Consolidating ${drafts.length} draft decision(s) via ${resolved.provider}...`);
        const result = await consolidateDrafts(store, llm, specMapResult);
        consolidated = result.decisions;
        supersededIds = result.supersededIds;
        dispositions = result.dispositions;
      } else {
        if (!options.json) logger.discovery(`No drafts found — extracting decisions from diff via ${resolved.provider}...`);
        const specMap = specMapResult ?? await buildSpecMap({ rootPath, openspecPath });
        // Use staged-only scope so the fallback only sees what's actually being committed.
        consolidated = await extractFromDiff({ rootPath, stagedOnly: true, specMap, sessionId: store.sessionId, llm });
      }
      if (consolidated.length === 0) {
        // Nothing survived — but every draft still gets its verdict, so the author
        // can read WHY rather than watch the draft disappear
        // (change: explain-decision-rejection).
        const updatedStore = dispositions.length > 0
          ? await updateDecisionStore(rootPath, (s) => applyConsolidationOutcome(s, {
            originalDraftIds: new Set(drafts.map((draft) => draft.id)),
            originalDrafts: drafts,
            capturedDecisions: store.decisions,
            verified: [],
            phantom: [],
            supersededIds,
            dispositions,
          }), 'agent')
          : store;
        const classifications = reconcileDecisionClassifications(updatedStore, {
          verified: [],
          phantom: [],
          unassessed: drafts,
        });
        const unresolvedUnassessed = classifications.unassessed.filter(decisionClassificationIsUnresolved);
        if (options.gate && openloreConfig.governance?.autopilot === true) {
          await runAutopilotGate(rootPath, openloreConfig, options.json, classifications.unassessed);
          return;
        }
        if (!options.json) {
          console.log('No architectural decisions were produced; original drafts remain pending.');
        } else {
          process.stdout.write(JSON.stringify({ ...classifications, missing: [], dispositions: [] }, null, 2) + '\n');
        }
        if (options.gate && unresolvedUnassessed.length > 0) process.exitCode = 1;
        return;
      }

      // Step 2 — Build diff + commit messages for verification
      let combinedDiff = '';
      let commitMessages = '';
      try {
        // Root-only (see api/decisions.ts): getFileDiff below the repo root empties
        // out on cwd-relative pathspecs, misclassifying real decisions as phantom.
        if (await isGitRepositoryRoot(rootPath)) {
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
      const { verified, phantom, unassessed, missing } = combinedDiff
        ? await verifyDecisions(consolidated, combinedDiff, llm, commitMessages)
        : { verified: markVerificationEvidenceAbsent(consolidated), phantom: [], unassessed: [], missing: [] };

      // Step 4 — Persist
      // Consolidated decisions replace their source drafts. An unassessed decision
      // is persisted as a draft, so omission by the verifier never drops it.
      // Explicitly superseded IDs from prior sessions are still rejected.
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
      const withProvenance = [...verified, ...phantom, ...unassessed].map((d) => {
        const original = originalById.get(d.id);
        if (original) return { ...d, status: unassessed.some((candidate) => candidate.id === d.id) ? 'draft' as const : d.status, recordedAt: original.recordedAt };
        // Merged decision — anchor to earliest superseded draft's recordedAt
        const recordedAt = earliestSupersededAt ?? d.recordedAt;
        return unassessed.some((candidate) => candidate.id === d.id)
          ? { ...d, status: 'draft' as const, recordedAt }
          : { ...d, recordedAt };
      });
      // CAS persist: apply the consolidation result to the FRESHEST store, so a
      // record_decision/approve committed concurrently (different lock) is preserved
      // rather than clobbered by this stale snapshot. replaceDecisions (not upsert)
      // because consolidated decisions share IDs with their original drafts.
      const unassessedIds = new Set(unassessed.map((decision) => decision.id));
      const finalDispositions = withVerificationOutcome(
        dispositions.filter((disposition) => !unassessedIds.has(disposition.id)),
        new Set(phantom.map((d) => d.id)),
      );
      const consolidationSnapshot = await sourceSnapshotFingerprint(rootPath, false);
      const updatedStore = await updateDecisionStore(rootPath, (s) => {
        // Every input draft's verdict, written alongside the status transition.
        const next = applyConsolidationOutcome(s, {
          originalDraftIds,
          originalDrafts: drafts,
          capturedDecisions: store.decisions,
          verified: withProvenance.filter((decision) => decision.status === 'verified'),
          phantom: withProvenance.filter((decision) => decision.status === 'phantom'),
          unassessed: withProvenance.filter((decision) => decision.status === 'draft'),
          supersededIds,
          dispositions: finalDispositions,
        });
        return {
          ...next,
          lastConsolidatedAt: new Date().toISOString(),
          lastConsolidatedSourceFingerprint: consolidationSnapshot?.fingerprint,
        };
      });
      const classifications = reconcileDecisionClassifications(updatedStore, {
        verified,
        phantom,
        unassessed: withProvenance.filter((decision) => unassessedIds.has(decision.id)),
      });
      const unresolvedVerified = classifications.verified.filter(decisionClassificationIsUnresolved);
      const reviewableVerified = unresolvedVerified.filter((decision) => decision.status === 'verified');
      const unresolvedPhantom = classifications.phantom.filter(decisionClassificationIsUnresolved);
      const unresolvedUnassessed = classifications.unassessed.filter(decisionClassificationIsUnresolved);

      // Decision autopilot: resolve the freshly-verified decisions without
      // blocking — auto-accept, sync, advisory line, exit 0. (add-decision-autopilot)
      if (options.gate && openloreConfig.governance?.autopilot === true) {
        await runAutopilotGate(rootPath, openloreConfig, options.json, classifications.unassessed);
        return;
      }

      if (options.json) {
        process.stdout.write(JSON.stringify({ ...classifications, missing }, null, 2) + '\n');
        if (options.gate && classificationsBlockGate(classifications, missing.length)) process.exitCode = 1;
        return;
      }

      // Interactive TUI approval when running in a terminal
      if (options.gate && process.stdin.isTTY && process.stdout.isTTY && reviewableVerified.length > 0) {
        const results = await runTuiApproval(reviewableVerified);

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

        const stillPending = reviewableVerified.filter(
          (d) => !results.has(d.id) || results.get(d.id) === 'skipped',
        );
        const approved = reviewableVerified.filter((d) => results.get(d.id) === 'approved');
        const rejected = reviewableVerified.filter((d) => results.get(d.id) === 'rejected');

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
        const concurrentlyPending = unresolvedVerified.filter((decision) => decision.status !== 'verified');
        if (concurrentlyPending.length > 0) {
          logger.warning(`${concurrentlyPending.length} verified classification(s) changed concurrently and remain pending — commit blocked.`);
          process.exitCode = 1;
        }
        if (unresolvedUnassessed.length > 0) {
          logger.warning(`${unresolvedUnassessed.length} decision(s) were not assessed and remain unresolved — commit blocked.`);
          process.exitCode = 1;
        }
        if (unresolvedPhantom.length > 0) {
          logger.warning(`${unresolvedPhantom.length} phantom classification(s) changed concurrently and remain unresolved — commit blocked.`);
          process.exitCode = 1;
        }

        displayMissing(missing);
        if (missing.length > 0) process.exitCode = 1;
        return;
      }

      // Non-TTY (agent/IDE context): structured JSON for ACP consumption
      if (options.gate && !process.stdout.isTTY) {
        const payload = {
          gated: classificationsBlockGate(classifications, missing.length),
          verified: classifications.verified.map((d) => ({
            id: d.id,
            title: d.title,
            status: d.status,
            rationale: d.rationale,
            consequences: d.consequences,
            proposedRequirement: d.proposedRequirement,
            affectedDomains: d.affectedDomains,
            affectedFiles: d.affectedFiles,
            confidence: d.confidence,
            verificationEvidence: d.verificationEvidence,
            contentOrigin: d.contentOrigin,
          })),
          phantom: classifications.phantom.map((d) => ({ id: d.id, title: d.title, status: d.status })),
          unassessed: classifications.unassessed.map((d) => ({ id: d.id, title: d.title, status: d.status })),
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

      if (unresolvedVerified.length > 0) {
        console.log('\nVerified classifications still unresolved (current persisted status shown):');
        for (const d of unresolvedVerified) displayDecision(d, options.verbose);
      }

      if (classifications.phantom.length > 0) {
        console.log('\nPhantom decisions (recorded but not found in diff — may have been rolled back):');
        for (const d of classifications.phantom) displayDecision(d, options.verbose);
      }

      if (classifications.unassessed.length > 0) {
        console.log('\nUnassessed decisions (current persisted status shown — verification did not classify them):');
        for (const d of classifications.unassessed) displayDecision(d, options.verbose);
      }

      if (unresolvedVerified.length > 0 || classifications.phantom.length > 0 || classifications.unassessed.length > 0) printDecisionLegend();

      displayMissing(missing);

      console.log('\nApprove with: openlore decisions --approve <id>');
      console.log('Reject with:  openlore decisions --reject <id>');
      console.log('Sync all approved: openlore decisions --sync');

      if (options.gate && missing.length > 0) {
        logger.warning(`\nCommit gated — ${missing.length} undocumented change(s) require a decision. Record with: openlore decisions --record or record_decision MCP tool.`);
        process.exitCode = 1;
      } else if (options.gate && unresolvedPhantom.length > 0) {
        logger.warning(`\nCommit gated — ${unresolvedPhantom.length} phantom classification(s) changed concurrently and remain unresolved.`);
        process.exitCode = 1;
      } else if (options.gate && unresolvedUnassessed.length > 0) {
        logger.warning(`\nCommit gated — ${unresolvedUnassessed.length} decision(s) were not assessed and remain unresolved. Re-run consolidation before committing.`);
        process.exitCode = 1;
      } else if (options.gate && unresolvedVerified.length > 0) {
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
      const stagedSnapshot = await sourceSnapshotFingerprint(rootPath, true);
      const consolidatedRecently = matchesConsolidationReceipt(
        store.lastConsolidatedAt,
        store.lastConsolidatedSourceFingerprint,
        stagedSnapshot?.fingerprint,
        Date.now(),
        CONSOLIDATION_GRACE_PERIOD_MS,
      );

      // The staged-source check is the only input requiring git; resolve it lazily,
      // only in the state where it can change the outcome (nothing else gates).
      let isGitRepo = false;
      let hasStagedSourceChanges = stagedSnapshot?.hasSourceChanges ?? false;
      if (approved.length === 0 && verified.length === 0 && drafts.length === 0
          && !consolidatedRecently && activeCount === 0) {
        isGitRepo = await isGitRepositoryRoot(rootPath);
        if (isGitRepo && stagedSnapshot === null) {
          try {
            const { stdout } = await execFileAsync(
              'git', gitPathArgs('diff', '--cached', '--name-only', '--diff-filter=ACDMR'),
              { cwd: rootPath },
            );
            const stagedFiles = stdout.trim().split('\n').filter(Boolean);
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
          verificationEvidence: d.verificationEvidence,
          contentOrigin: d.contentOrigin,
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

      const openspecPath = resolveOpenspecDir(rootPath, openloreConfig.openspecPath);
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

decisionsCommand
  .command('constraints')
  .description('Show declared decision-constraint eligibility and lifecycle coverage')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { json: boolean }, cmd: Command) => {
    const parentOpts = (cmd.parent?.opts() ?? {}) as { json?: boolean };
    const json = Boolean(opts.json || parentOpts.json);
    const restoreStdout = json ? redirectConsoleToStderr() : null;
    try {
      const rootPath = process.cwd();
      const config = await readOpenLoreConfig(rootPath);
      const state = await loadDecisionConstraintState(rootPath, config?.openspecPath);
      const report = {
        ...state.ledger,
        retiredRules: state.retiredRules,
        malformedFindings: state.malformedFindings,
      };
      if (json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        return;
      }
      const adoption = report.adoption.ratio === null
        ? 'not applicable (0 authoritative)'
        : `${report.adoption.constrained}/${report.adoption.authoritative} (${(report.adoption.ratio * 100).toFixed(1)}%)`;
      const coverage = report.coverage.ratio === null
        ? 'not applicable (0 eligible)'
        : `${report.coverage.constrainedEligible}/${report.coverage.eligible} (${(report.coverage.ratio * 100).toFixed(1)}%)`;
      const lines = [
        'Decision constraint eligibility',
        `Adoption: ${adoption}`,
        `Coverage: ${coverage}`,
        `Unclassified: ${report.unclassifiedCount}`,
        `Active rules: ${report.activeRuleCount}`,
        `Retired rules: ${report.retiredRules.length}`,
        `Malformed blocks: ${report.malformedFindings.length}`,
      ];
      if (report.coverageGaps.length > 0) {
        lines.push(`Coverage gaps: ${report.coverageGaps.map((gap) => `${gap.decisionId} ${gap.title}`).join('; ')}`);
      }
      process.stdout.write(safe(lines.join('\n') + '\n', { keepNewlines: true }));
    } catch (error) {
      logger.error(`decision constraint report failed: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      restoreStdout?.();
    }
  });

/** Resolve a `--since` value to an epoch ms cutoff: ISO date, or a git ref's commit time. */
async function resolveSinceCutoff(rootPath: string, since: string): Promise<number> {
  const asDate = Date.parse(since);
  if (!Number.isNaN(asDate)) return asDate;
  // `Date.parse` returning NaN is not validation: it lets `--output=/path` through to
  // git, which reads it as a diff OPTION and truncates that file. Every other
  // ref-consuming path in the repo validates first; this one is the exception.
  validateGitRef(since);
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
        console.log(`${when}  [${safe(e.id)}] ${safe(e.from ?? '∅')} → ${safe(e.to)}  by ${safe(e.actor)}${commit}  ${safe(e.title)}`);
      }
      console.log(`\nTotal: ${entries.length} transition(s)`);
    } catch (err) {
      logger.error(`decisions log failed: ${(err as Error).message}`);
      process.exitCode = 1;
    } finally {
      restoreStdout?.();
    }
  });

decisionsCommand
  .command('status')
  .argument('<id>', '8-char decision/draft id')
  .description('Report a draft\'s terminal disposition and reason (pending, promoted, merged-into, rejected)')
  .option('--json', 'Output as JSON', false)
  .action(async (id: string, opts: { json: boolean }, cmd: Command) => {
    const parentOpts = (cmd.parent?.opts() ?? {}) as { json?: boolean };
    const json = Boolean(opts.json || parentOpts.json);
    const restoreStdout = json ? redirectConsoleToStderr() : null;
    try {
      const rootPath = process.cwd();
      const store = await loadDecisionStore(rootPath);
      const decision = store.decisions.find((d) => d.id === id);
      if (!decision) {
        // An id the store has never held is "not found" — never a rejection.
        if (json) {
          process.stdout.write(JSON.stringify({ id, found: false, note: 'No decision or draft with this id — not found, NOT rejected.' }, null, 2) + '\n');
        } else {
          logger.warning(`No decision or draft with id ${safe(id)} — not found, NOT rejected.`);
        }
        process.exitCode = 1;
        return;
      }

      const { disposition, reason, mergedIntoId } = readDisposition(decision);
      const entry = DECISION_DISPOSITION_REASONS[reason];
      if (json) {
        process.stdout.write(JSON.stringify({
          id: decision.id,
          found: true,
          status: decision.status,
          disposition,
          reason,
          reasonDescription: entry.description,
          ...(entry.nextAction ? { nextAction: entry.nextAction } : {}),
          ...(mergedIntoId ? { mergedIntoId } : {}),
          ...(decision.dispositionAt ? { dispositionAt: decision.dispositionAt } : {}),
          title: decision.title,
          contentOrigin: decision.contentOrigin,
          ...(decision.verificationEvidence ? { verificationEvidence: decision.verificationEvidence } : {}),
          ...(decision.authorStatement ? { authorStatement: decision.authorStatement } : {}),
        }, null, 2) + '\n');
        return;
      }

      logger.section(`Decision ${safe(decision.id)}`);
      console.log(`  title:       ${safe(decision.title)}`);
      console.log(`  status:      ${safe(decision.status)}`);
      console.log(`  disposition: ${describeDisposition(decision)}`);
      // Provenance the author needs to interpret the served text.
      console.log(`  content:     ${safe(decision.contentOrigin)}${decision.verificationEvidence ? ` (evidence: ${safe(decision.verificationEvidence)})` : ''}`);
      if (decision.authorStatement) {
        console.log('  authorStatement (your recorded wording, kept verbatim):');
        console.log(`    title:     ${safe(decision.authorStatement.title)}`);
        console.log(`    rationale: ${safe(decision.authorStatement.rationale)}`);
      }
    } catch (err) {
      logger.error(`decisions status failed: ${(err as Error).message}`);
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
            verificationEvidence: d.verificationEvidence,
            contentOrigin: d.contentOrigin,
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
