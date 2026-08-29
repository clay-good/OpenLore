/**
 * Guard for the documentation index (change: refine-happy-path-and-defaults /
 * DocumentationSingleSourceOfTruth). `docs/README.md` is the task→doc map: it must
 * exist and every doc it points at must resolve, so the index can't rot into broken
 * links as docs are renamed or moved. Mirrors mcp-tool-count-doc.test.ts (reads the
 * real files from the repo root).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { CALLGRAPH_LANGUAGES } from '../../core/analyzer/call-graph.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const docsDir = join(repoRoot, 'docs');
const indexPath = join(docsDir, 'README.md');

/** Extract markdown link targets `[text](target)` from a doc body. */
function linkTargets(md: string): string[] {
  const targets: string[] = [];
  const re = /\[[^\]]+\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) targets.push(m[1]);
  return targets;
}

describe('documentation index (DocumentationSingleSourceOfTruth)', () => {
  it('docs/README.md exists', () => {
    expect(existsSync(indexPath), 'docs/README.md (the task→doc index) must exist').toBe(true);
  });

  it('every relative doc link in the index resolves to an existing file', () => {
    const md = readFileSync(indexPath, 'utf8');
    const broken: string[] = [];
    for (const target of linkTargets(md)) {
      // Only check in-repo relative links; skip http(s)/anchors-only.
      if (/^https?:\/\//.test(target) || target.startsWith('#')) continue;
      const filePart = target.split('#')[0]; // drop any #anchor
      if (!filePart) continue;
      const abs = resolve(docsDir, filePart);
      if (!existsSync(abs)) broken.push(target);
    }
    expect(broken, `broken doc links in docs/README.md: ${broken.join(', ')}`).toEqual([]);
  });

  it('points at the canonical page for each known overlapping concept', () => {
    const md = readFileSync(indexPath, 'utf8');
    // The canonical sources of truth named in the consolidation.
    for (const canonical of ['install.md', 'language-support.md', 'configuration.md', 'providers.md', 'mcp-tools.md']) {
      expect(md.includes(canonical), `index should reference canonical page ${canonical}`).toBe(true);
    }
  });

  it('the canonical language page names every call-graph-backed language', () => {
    const md = readFileSync(join(docsDir, 'language-support.md'), 'utf8');
    const documented = new Set(
      [...md.matchAll(/^\| ([^|]+?) \|/gm)].map(match => match[1].trim()),
    );
    const missing = [...CALLGRAPH_LANGUAGES].filter(language => !documented.has(language)).sort();

    expect(missing, `language-support.md is missing call-graph-backed rows: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the legacy language page as a redirect to the canonical page', () => {
    const legacy = readFileSync(join(docsDir, 'languages.md'), 'utf8');

    expect(legacy).toContain('[language support guide](language-support.md)');
    expect(legacy).not.toContain('| Language | Extensions |');
  });
});
