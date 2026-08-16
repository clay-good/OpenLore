/**
 * openlore refresh-stories command
 *
 * Scans story files for stale risk_context sections and re-runs annotate_story
 * on any story that references functions/files changed since the last commit.
 * Can be installed as a post-commit hook.
 */

import { Command } from 'commander';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import { fileExists } from '../../utils/command-helpers.js';
import { gitPathArgs } from '../../utils/git-args.js';
import { handleAnnotateStory } from '../../core/services/mcp-handlers/change.js';
import {
  displayHookPath,
  hookManagerWarning,
  isResolvedGitRepository,
  resolveGitHookTarget,
  updateHookFile,
} from '../git-hooks.js';

// ============================================================================
// HOOK MANAGEMENT
// ============================================================================

const HOOK_MARKER = '# openlore-refresh-hook';

const HOOK_CONTENT = `
${HOOK_MARKER}
# Automatically refresh stale risk_context in story files after structural changes.
# Installed by: openlore refresh-stories --install-hook

npx --yes openlore refresh-stories 2>/dev/null || true
# end-openlore-refresh-hook
`.trimStart();

export async function installPostCommitHook(rootPath: string): Promise<void> {
  const target = await resolveGitHookTarget(rootPath, 'post-commit');
  const hookPath = target.hookPath;

  if (!(await isResolvedGitRepository(rootPath, target))) {
    logger.error('Not a git repository. Cannot install hook.');
    process.exitCode = 1;
    return;
  }
  if (!target.canInstall) {
    logger.warning(hookManagerWarning(target, 'openlore refresh-stories'));
    return;
  }
  let alreadyInstalled = false;
  let appended = false;
  const result = await updateHookFile(hookPath, (existing) => {
    if (existing?.includes(HOOK_MARKER)) { alreadyInstalled = true; return null; }
    appended = existing !== null;
    return existing ? existing.trimEnd() + '\n\n' + HOOK_CONTENT : '#!/bin/sh\n\n' + HOOK_CONTENT;
  });
  if (result.status === 'unavailable') {
    logger.warning(`Cannot install the refresh-stories hook at ${displayHookPath(hookPath)}: ${result.reason}`);
    return;
  }
  if (alreadyInstalled) {
    logger.success('Post-commit hook is already installed.');
    return;
  }
  if (appended) logger.discovery('Existing post-commit hook found. Appending openlore refresh check.');
  logger.success(`Post-commit hook installed at ${displayHookPath(hookPath)}`);
  logger.discovery('Story risk_context will be refreshed after each commit that touches source files.');
}

export async function uninstallPostCommitHook(rootPath: string): Promise<void> {
  const { hookPath } = await resolveGitHookTarget(rootPath, 'post-commit');
  let found = false;
  let blockFound = false;
  let deleted = false;
  const result = await updateHookFile(hookPath, (existing) => {
    if (existing === null) return null;
    found = true;
    if (!existing.includes(HOOK_MARKER)) return null;
    blockFound = true;
    const cleaned = existing
      .replace(/\n*# openlore-refresh-hook[\s\S]*?# end-openlore-refresh-hook\n*/g, '')
      .trim();
    if (!cleaned || cleaned === '#!/bin/sh') { deleted = true; return undefined; }
    return cleaned + '\n';
  });
  if (result.status === 'unavailable') {
    logger.warning(`Cannot uninstall the refresh-stories hook at ${displayHookPath(hookPath)}: ${result.reason}`);
  } else if (!found) {
    logger.warning('No post-commit hook found.');
  } else if (!blockFound) {
    logger.warning('Post-commit hook does not contain openlore refresh check.');
  } else if (deleted) {
    logger.success('Post-commit hook removed (file deleted — was only openlore).');
  } else {
    logger.success('OpenLore refresh check removed from post-commit hook.');
  }
}

// ============================================================================
// STORY SCANNING
// ============================================================================

/** Files changed in the last commit (HEAD~1..HEAD). */
function getLastCommitChangedFiles(rootPath: string): string[] {
  try {
    const output = execFileSync('git', gitPathArgs('diff', 'HEAD~1', 'HEAD', '--name-only'), {
      cwd: rootPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .split('\n')
      .map((l: string) => l.trim())
      .filter(Boolean);
  } catch {
    // Might be the first commit or a shallow clone — fall back to HEAD only
    try {
      const output = execFileSync('git', gitPathArgs('diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD'), {
        cwd: rootPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output
        .split('\n')
        .map((l: string) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/** Recursively collect *.md story files under storiesDir. */
async function collectStoryFiles(storiesDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry.endsWith('.md')) {
        results.push(full);
      } else if (!entry.startsWith('.')) {
        // Recurse into subdirectories, skip hidden dirs
        try {
          const { stat } = await import('node:fs/promises');
          const s = await stat(full);
          if (s.isDirectory()) await walk(full);
        } catch {
          // ignore
        }
      }
    }
  }

  await walk(storiesDir);
  return results;
}

/**
 * Returns true if the story file's ## Risk Context section references any of
 * the provided changed file paths (matched by basename or partial path).
 */
async function storyReferencesChangedFiles(
  storyPath: string,
  changedFiles: string[],
): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(storyPath, 'utf-8');
  } catch {
    return false;
  }

  // Only consider stories that have a Risk Context section
  if (!content.includes('## Risk Context')) return false;

  // Extract just the Risk Context block for targeted matching
  const rcMatch = content.match(/## Risk Context([\s\S]*?)(?:\n## |\n---|\s*$)/);
  const rcBlock = rcMatch ? rcMatch[1] : content;

  for (const changed of changedFiles) {
    // Match by filename (basename) or last two path segments
    const segments = changed.replace(/\\/g, '/').split('/');
    const basename = segments[segments.length - 1];
    const tail2 = segments.slice(-2).join('/');

    if (rcBlock.includes(basename) || rcBlock.includes(tail2) || rcBlock.includes(changed)) {
      return true;
    }
  }

  return false;
}

/** Extract a one-line description from a story file (first non-blank line after # Title). */
function extractStoryDescription(content: string): string {
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : 'story';

  // Look for a short AC or goal line
  const goalMatch = content.match(/(?:Goal|Summary|As a)[^\n]{0,120}/i);
  if (goalMatch) return `${title} — ${goalMatch[0].trim()}`;

  return title;
}

// ============================================================================
// COMMAND
// ============================================================================

export const refreshStoriesCommand = new Command('refresh-stories')
  .description('Refresh stale risk_context in story files after code changes')
  .option(
    '--directory <path>',
    'Project root directory',
    process.cwd()
  )
  .option(
    '--stories <path>',
    'Directory containing story files (default: bmad/stories relative to --directory)',
  )
  .option(
    '--install-hook',
    'Install as post-commit hook',
    false
  )
  .option(
    '--uninstall-hook',
    'Remove post-commit hook',
    false
  )
  .option(
    '--dry-run',
    'Show which stories would be refreshed without writing changes',
    false
  )
  .option(
    '--all',
    'Refresh all stories with a risk_context section (ignore changed-file filter)',
    false
  )
  .addHelpText(
    'after',
    `
Examples:
  $ openlore refresh-stories                       Refresh stories affected by last commit
  $ openlore refresh-stories --all                 Refresh every story that has risk_context
  $ openlore refresh-stories --dry-run             Show what would be refreshed
  $ openlore refresh-stories --install-hook        Install as post-commit hook
  $ openlore refresh-stories --uninstall-hook      Remove post-commit hook
  $ openlore refresh-stories --stories ./stories   Use a custom stories directory
`
  )
  .action(async function (this: Command, options: {
    directory?: string;
    stories?: string;
    installHook?: boolean;
    uninstallHook?: boolean;
    dryRun?: boolean;
    all?: boolean;
  }) {
    const rootPath = resolve(options.directory ?? process.cwd());

    // ── HOOK MANAGEMENT ──────────────────────────────────────────────────────
    if (options.installHook) {
      await installPostCommitHook(rootPath);
      return;
    }
    if (options.uninstallHook) {
      await uninstallPostCommitHook(rootPath);
      return;
    }

    // ── RESOLVE STORIES DIR ───────────────────────────────────────────────────
    const storiesDir = options.stories
      ? resolve(options.stories)
      : join(rootPath, 'bmad', 'stories');

    if (!(await fileExists(storiesDir))) {
      logger.warning(`Stories directory not found: ${storiesDir}`);
      logger.discovery('Use --stories <path> to specify the correct location.');
      return;
    }

    // ── GET CHANGED FILES ─────────────────────────────────────────────────────
    let changedFiles: string[] = [];
    if (!options.all) {
      changedFiles = getLastCommitChangedFiles(rootPath);

      // Filter to source files only (skip docs, specs, stories themselves)
      changedFiles = changedFiles.filter(f => {
        const lower = f.toLowerCase();
        return (
          !lower.startsWith('openspec/') &&
          !lower.startsWith('bmad/') &&
          !lower.startsWith('docs/') &&
          !lower.endsWith('.md') &&
          !lower.endsWith('.json') &&
          !lower.endsWith('.yaml') &&
          !lower.endsWith('.yml')
        );
      });

      if (changedFiles.length === 0) {
        logger.discovery('No source file changes in last commit. Nothing to refresh.');
        return;
      }
    }

    // ── COLLECT STORY FILES ───────────────────────────────────────────────────
    logger.section('Story Risk Context Refresh');
    logger.discovery(`Scanning stories in ${storiesDir}...`);

    const allStories = await collectStoryFiles(storiesDir);
    if (allStories.length === 0) {
      logger.discovery('No story files found.');
      return;
    }

    logger.info('Stories found', allStories.length);
    if (!options.all) {
      logger.info('Source files changed', changedFiles.length);
    }
    logger.blank();

    // ── DETERMINE WHICH STORIES NEED REFRESH ─────────────────────────────────
    const toRefresh: string[] = [];

    for (const storyPath of allStories) {
      const needsRefresh = options.all
        ? await (async () => {
            try {
              const c = await readFile(storyPath, 'utf-8');
              return c.includes('## Risk Context');
            } catch {
              return false;
            }
          })()
        : await storyReferencesChangedFiles(storyPath, changedFiles);

      if (needsRefresh) toRefresh.push(storyPath);
    }

    if (toRefresh.length === 0) {
      logger.success('No story risk_context sections reference changed files. All up to date.');
      return;
    }

    logger.info('Stories to refresh', toRefresh.length);
    logger.blank();

    if (options.dryRun) {
      logger.warning('Dry run — no changes written:');
      for (const p of toRefresh) {
        logger.discovery(`  ${p.replace(rootPath + '/', '')}`);
      }
      return;
    }

    // ── REFRESH ───────────────────────────────────────────────────────────────
    let refreshed = 0;
    let failed = 0;

    for (const storyPath of toRefresh) {
      const rel = storyPath.replace(rootPath + '/', '');
      logger.analysis(`Refreshing ${rel}...`);

      try {
        const content = await readFile(storyPath, 'utf-8');
        const description = extractStoryDescription(content);

        await handleAnnotateStory(rootPath, storyPath, description);
        logger.success(`  Refreshed: ${rel}`);
        refreshed++;
      } catch (err) {
        logger.warning(`  Failed to refresh ${rel}: ${(err as Error).message}`);
        failed++;
      }
    }

    logger.blank();
    if (failed === 0) {
      logger.success(`Refreshed ${refreshed} story file${refreshed !== 1 ? 's' : ''}.`);
    } else {
      logger.warning(`Refreshed ${refreshed}, failed ${failed}.`);
    }
  });
