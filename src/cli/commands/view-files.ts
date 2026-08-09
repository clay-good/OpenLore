import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { safeJoin } from '../../utils/path-confinement.js';

export const MAX_VIEW_SPEC_BYTES = 2 * 1024 * 1024;

export interface CollectedSpecMarkdown {
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface CollectSpecOptions {
  maxBytes?: number;
  confinementRoot?: string;
}

function sameFile(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Read through a no-follow descriptor, bounded to `maxBytes`, and verify the
 * pathname still names the same confined inode after the read.
 */
export async function readConfinedFile(
  confinementRoot: string,
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  safeJoin(confinementRoot, relative(confinementRoot, filePath));
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Refusing non-regular file');
  if (before.size > maxBytes) throw new Error('File exceeds viewer byte limit');

  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new Error('File changed during confinement check');

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) throw new Error('File exceeds viewer byte limit');

    safeJoin(confinementRoot, relative(confinementRoot, filePath));
    const after = await lstat(filePath);
    if (!sameFile(opened, after) || after.isSymbolicLink()) {
      throw new Error('File changed during read');
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Concatenate Markdown below `root` without following repository-controlled
 * symlinks. Traversal and reads stop at the byte ceiling.
 */
export async function collectSpecMarkdown(
  root: string,
  options: CollectSpecOptions = {},
): Promise<CollectedSpecMarkdown> {
  const maxBytes = options.maxBytes ?? MAX_VIEW_SPEC_BYTES;
  const confinementRoot = options.confinementRoot ?? root;
  let content = '';
  let bytes = 0;
  let truncated = false;

  const visit = async (dir: string): Promise<void> => {
    if (truncated) return;
    try {
      safeJoin(confinementRoot, relative(confinementRoot, dir));
    } catch {
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) break;
      if (entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);
      let stats;
      try {
        stats = await lstat(fullPath);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!stats.isFile() || !entry.name.endsWith('.md')) continue;

      const separatorBytes = bytes === 0 ? 0 : 2;
      const remaining = maxBytes - bytes - separatorBytes;
      if (stats.size > remaining) {
        truncated = true;
        break;
      }

      try {
        const file = await readConfinedFile(confinementRoot, fullPath, remaining);
        if (separatorBytes > 0) content += '\n\n';
        content += file.toString('utf8');
        bytes += file.byteLength + separatorBytes;
      } catch (err) {
        if (err instanceof Error && err.message.includes('byte limit')) truncated = true;
        // A file may disappear or be swapped between discovery and read; skip it.
      }
    }
  };

  const rootStats = await lstat(root).catch(() => null);
  if (rootStats?.isDirectory() && !rootStats.isSymbolicLink()) await visit(root);
  return { content, bytes, truncated };
}
