import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_VIEW_SPEC_BYTES = 2 * 1024 * 1024;

export interface CollectedSpecMarkdown {
  content: string;
  bytes: number;
  truncated: boolean;
}

/**
 * Concatenate Markdown below `root` without following repository-controlled
 * symlinks. Traversal and reads stop at the byte ceiling.
 */
export async function collectSpecMarkdown(
  root: string,
  maxBytes = MAX_VIEW_SPEC_BYTES,
): Promise<CollectedSpecMarkdown> {
  let content = '';
  let bytes = 0;
  let truncated = false;

  const visit = async (dir: string): Promise<void> => {
    if (truncated) return;

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
      if (stats.size + separatorBytes > maxBytes - bytes) {
        truncated = true;
        break;
      }

      try {
        const file = await readFile(fullPath);
        if (file.byteLength + separatorBytes > maxBytes - bytes) {
          truncated = true;
          break;
        }
        if (separatorBytes > 0) content += '\n\n';
        content += file.toString('utf8');
        bytes += file.byteLength + separatorBytes;
      } catch {
        // A file may disappear between lstat and read; skip it.
      }
    }
  };

  const rootStats = await lstat(root).catch(() => null);
  if (rootStats?.isDirectory() && !rootStats.isSymbolicLink()) await visit(root);
  return { content, bytes, truncated };
}
