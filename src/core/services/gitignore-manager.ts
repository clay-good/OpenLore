/**
 * Gitignore management service
 *
 * Handles adding entries to .gitignore
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import { execFileGit } from '../../utils/git-exec.js';

/**
 * Check if .gitignore exists
 */
export async function gitignoreExists(rootPath: string): Promise<boolean> {
  return fileExists(join(rootPath, '.gitignore'));
}

/**
 * Read .gitignore content
 */
export async function readGitignore(rootPath: string): Promise<string | null> {
  const gitignorePath = join(rootPath, '.gitignore');
  try {
    return await readFile(gitignorePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Check if an entry is already in .gitignore
 */
export async function isInGitignore(rootPath: string, entry: string): Promise<boolean> {
  const content = await readGitignore(rootPath);
  if (!content) {
    return false;
  }

  // Normalize entry (remove leading/trailing slashes for comparison)
  const normalizedEntry = entry.replace(/^\/+|\/+$/g, '');

  // Check each line
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (trimmed.startsWith('#') || trimmed === '') {
      continue;
    }
    // Normalize the line for comparison
    const normalizedLine = trimmed.replace(/^\/+|\/+$/g, '');
    if (normalizedLine === normalizedEntry) {
      return true;
    }
  }

  return false;
}

/**
 * Add exactly one line, `entry`, to .gitignore: no comment and no blank line (change:
 * spec-framework-neutrality, task 1.3).
 */
export async function addToGitignore(
  rootPath: string,
  entry: string,
): Promise<boolean> {
  const gitignorePath = join(rootPath, '.gitignore');

  // Check if already present
  if (await isInGitignore(rootPath, entry)) {
    return false; // Already exists
  }

  // Read existing content or start fresh
  let content = (await readGitignore(rootPath)) ?? '';

  // Ensure file ends with newline before adding
  if (content.length > 0 && !content.endsWith('\n')) {
    content += '\n';
  }

  content += `${entry}\n`;

  // Write back
  await writeFile(gitignorePath, content, 'utf-8');
  return true;
}

/**
 * Ensure `entry` is ignored, creating .gitignore when it does not exist.
 *
 * Idempotent. This is the single source of truth for the "make sure X is
 * gitignored" intent — `init` and the `run` pipeline previously inlined this
 * logic four times, and each copy guarded the write with `if (hasGitignore)`,
 * so a fresh `git init` repo (no .gitignore yet) never got its entry added.
 * Returns what happened so callers can choose their own user-facing message:
 *  - `'present'`  — already ignored; no write
 *  - `'appended'` — added to an existing .gitignore
 *  - `'created'`  — .gitignore did not exist and was created with the entry
 */
export async function ensureGitignored(
  rootPath: string,
  entry: string,
): Promise<'present' | 'appended' | 'created'> {
  const existed = await gitignoreExists(rootPath);
  if (existed && (await isInGitignore(rootPath, entry))) {
    return 'present';
  }
  // Already ignored some other way (a parent pattern, .git/info/exclude, a global excludes file):
  // writing the line again adds nothing.
  if (await gitIgnores(rootPath, entry)) return 'present';
  await addToGitignore(rootPath, entry);
  return existed ? 'appended' : 'created';
}

/** Whether git already ignores `entry` here. False outside a repository or when git fails. */
async function gitIgnores(rootPath: string, entry: string): Promise<boolean> {
  try {
    await execFileGit('git', ['check-ignore', '-q', '--', entry], { cwd: rootPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create .gitignore with initial entries
 */
export async function createGitignore(
  rootPath: string,
  entries: { entry: string; comment?: string }[]
): Promise<void> {
  let content = '';

  for (const { entry, comment } of entries) {
    if (comment) {
      content += `# ${comment}\n`;
    }
    content += `${entry}\n`;
  }

  const gitignorePath = join(rootPath, '.gitignore');
  await writeFile(gitignorePath, content, 'utf-8');
}
