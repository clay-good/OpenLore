/**
 * Test Writer
 *
 * Writes GeneratedTestFile objects to disk.
 * Respects --dry-run (preview only) and --merge (append new scenarios).
 *
 * Merge logic:
 *   When --merge is set, the writer reads the existing file and checks which
 *   scenario metadata tags are already present. New scenarios are appended;
 *   existing ones are skipped (no duplicate detection by content hash).
 */

import { readFile, mkdir } from 'node:fs/promises';
import { confinedAtomicWriteFile } from '../../utils/path-confinement.js';
import { dirname, resolve, sep } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import type { GeneratedTestFile } from '../../types/test-generator.js';

// ============================================================================
// TYPES
// ============================================================================

export interface WriteResult {
  written: number;
  skipped: number;
  merged: number;
  dryRunPreview?: string[];
}

// ============================================================================
// MERGE HELPERS
// ============================================================================

/** Extract scenario keys already present in a file via openlore: tags */
function extractExistingScenarioKeys(content: string): Set<string> {
  const keys = new Set<string>();
  const tagRegex = /(?:\/\/|#)\s*openlore:\s*(\{[^\n]+\})/g;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(content)) !== null) {
    try {
      const tag = JSON.parse(m[1]);
      if (tag.domain && tag.requirement && tag.scenario) {
        keys.add(`${tag.domain}::${tag.requirement}::${tag.scenario}`);
      }
    } catch {
      // malformed tag, ignore
    }
  }
  return keys;
}

/**
 * Extract the "blocks" (one per scenario) from generated content.
 * Each block starts with a openlore: tag comment line.
 */
function splitIntoBlocks(content: string): string[] {
  // Split on openlore: tag lines, keeping the delimiter
  const parts = content.split(/(?=(?:\/\/|#)\s*openlore:\s*\{)/);
  // First part is the import header (before any tags)
  return parts;
}

function buildMergedContent(
  existing: string,
  newContent: string,
  existingKeys: Set<string>
): { content: string; added: number } {
  const blocks = splitIntoBlocks(newContent);
  const scenarioBlocks = blocks.slice(1);

  let added = 0;
  const newBlocks: string[] = [];

  for (const block of scenarioBlocks) {
    const tagMatch = block.match(/(?:\/\/|#)\s*openlore:\s*(\{[^\n]+\})/);
    if (!tagMatch) continue;
    try {
      const tag = JSON.parse(tagMatch[1]);
      const key = `${tag.domain}::${tag.requirement}::${tag.scenario}`;
      if (!existingKeys.has(key)) {
        newBlocks.push(block);
        added++;
      }
    } catch {
      newBlocks.push(block); // keep unparseable blocks
      added++;
    }
  }

  if (newBlocks.length === 0) return { content: existing, added: 0 };

  const merged = existing.trimEnd() + '\n\n' + newBlocks.join('\n').trimStart();
  return { content: merged, added };
}

// ============================================================================
// PUBLIC API
// ============================================================================

export async function writeTestFiles(opts: {
  files: GeneratedTestFile[];
  rootPath: string;
  dryRun: boolean;
  merge: boolean;
}): Promise<WriteResult> {
  const { files, rootPath, dryRun, merge } = opts;
  const result: WriteResult = { written: 0, skipped: 0, merged: 0 };

  if (dryRun) {
    result.dryRunPreview = [];
  }

  for (const file of files) {
    const absPath = resolve(rootPath, file.outputPath);
    // Write confinement (mcp-security): outputPath is derived from spec domain /
    // requirement names — repo content. Most case-converters strip separators,
    // but the junit path (toPascalCase) does not, so a crafted requirement title
    // ("../../etc/x") could otherwise escape the root on write. Refuse any path
    // that resolves outside the project root.
    if (absPath !== rootPath && !absPath.startsWith(rootPath + sep)) {
      result.skipped++;
      continue;
    }
    const exists = await fileExists(absPath);

    if (dryRun) {
      result.dryRunPreview!.push(
        `  ${exists ? (merge ? '[merge]' : '[skip]') : '[new]'} ${file.outputPath} (${file.scenarios.length} scenario${file.scenarios.length > 1 ? 's' : ''})`
      );

      // Show assertion preview for the first scenario
      const firstScenario = file.scenarios[0];
      if (firstScenario) {
        const preview = file.content
          .split('\n')
          .filter((l) => l.trim() && !l.startsWith('import') && !l.includes('openlore:'))
          .slice(0, 8)
          .map((l) => `      ${l}`)
          .join('\n');
        if (preview) result.dryRunPreview!.push(preview);
      }
      continue;
    }

    if (exists && !merge) {
      file.isNew = false;
      result.skipped++;
      continue;
    }

    if (exists && merge) {
      const existing = await readFile(absPath, 'utf-8');
      const existingKeys = extractExistingScenarioKeys(existing);
      const { content, added } = buildMergedContent(existing, file.content, existingKeys);

      if (added === 0) {
        file.isNew = false;
        result.skipped++;
        continue;
      }

      // The lexical check above cannot see a symlinked path COMPONENT, and a plain `writeFile`
      // follows one — so a repo committing a link here had generated content written wherever it
      // pointed. The confined atomic writer re-checks on the real path and refuses a non-regular
      // target, like every other file OpenLore writes into a repository.
      await confinedAtomicWriteFile(rootPath, absPath, content);
      file.isNew = false;
      result.merged++;
      continue;
    }

    // New file
    await mkdir(dirname(absPath), { recursive: true });
    await confinedAtomicWriteFile(rootPath, absPath, file.content);
    file.isNew = true;
    result.written++;
  }

  return result;
}
