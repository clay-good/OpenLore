/**
 * openlore refresh-stories command
 *
 * Scans story files for stale risk_context sections and re-runs annotate_story
 * on any story that references functions/files changed since the last commit.
 * Can be installed as a post-commit hook.
 */

import { Command } from 'commander';
import { mkdir, readFile, writeFile, chmod, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import { fileExists } from '../../utils/command-helpers.js';
import { gitPathArgs } from '../../utils/git-args.js';
import { handleAnnotateStory } from '../../core/services/mcp-handlers/change.js';

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

async function installPostCommitHook(rootPath: string): Promise<void> {
  const hooksDir = join(rootPath, '.git', 'hooks');
  const hookPath = join(hooksDir, 'post-commit');

  if (!(await fileExists(join(rootPath, '.git')))) {
    logger.error('Not a git repository. Cannot install hook.');
    process.exitCode = 1;
    return;
  }

  await mkdir(hooksDir, { recursive: true });

  let existingContent: string;
  if (await fileExists(hookPath)) {
    existingContent = await readFile(hookPath, 'utf-8');

    if (existingContent.includes(HOOK_MARKER)) {
      logger.success('Post-commit hook is already installed.');
      return;
    }

    logger.discovery('Existing post-commit hook found. Appending openlore refresh check.');
    const newContent = existingContent.trimEnd() + '\n\n' + HOOK_CONTENT;
    await writeFile(hookPath, newContent, 'utf-8');
  } else {
    const newContent = '#!/bin/sh\n\n' + HOOK_CONTENT;
    await writeFile(hookPath, newContent, 'utf-8');
  }

  await chmod(hookPath, 0o755);
  logger.success('Post-commit hook installed at .git/hooks/post-commit');
  logger.discovery('Story risk_context will be refreshed after each commit that touches source files.');
}

async function uninstallPostCommitHook(rootPath: string): Promise<void> {
  const hookPath = join(rootPath, '.git', 'hooks', 'post-commit');

  if (!(await fileExists(hookPath))) {
    logger.warning('No post-commit hook found.');
    return;
  }

  const content = await readFile(hookPath, 'utf-8');
  if (!content.includes(HOOK_MARKER)) {
    logger.warning('Post-commit hook does not contain openlore refresh check.');
    return;
  }

  const newContent = content
    .replace(/\n*# openlore-refresh-hook[\s\S]*?# end-openlore-refresh-hook\n*/g, '')
    .trim();

  if (!newContent || newContent === '#!/bin/sh') {
    const { unlink } = await import('node:fs/promises');
    await unlink(hookPath);
    logger.success('Post-commit hook removed (file deleted — was only openlore).');
  } else {
    await writeFile(hookPath, newContent + '\n', 'utf-8');
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
