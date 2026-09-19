/**
 * The Pi extension runs inside the Pi host process, so it must stay dependency-light: orientation
 * comes from the warm daemon over RPC, never from an analyzer loaded in-process (decision
 * abee8e3e). This walks the extension's static relative-import graph and fails when it reaches a
 * module that would drag the daemon's own stack into the host (change: add-pi-openlore-status).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN = [
  'cli/commands/serve.ts',
  'core/services/edge-store.ts',
  'core/services/mcp-watcher.ts',
  'api/analyze.ts',
  'core/analyzer/call-graph.ts',
];

// Value imports and re-exports, plus bare side-effect imports. `import type` is erased at build
// time and loads nothing, so it is skipped.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g;

/** Map each reachable module to the module that first imported it. */
function importGraph(entry: string): Map<string, string | null> {
  const parents = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const target = resolve(dirname(file), match[1].replace(/\.js$/, '.ts'));
      if (!existsSync(target) || parents.has(target)) continue;
      parents.set(target, file);
      queue.push(target);
    }
  }
  return parents;
}

function chain(parents: Map<string, string | null>, file: string): string {
  const path: string[] = [];
  for (let at: string | null | undefined = file; at; at = parents.get(at)) path.unshift(relative(SRC, at));
  return path.join(' -> ');
}

describe('Pi extension import graph', () => {
  const parents = importGraph(resolve(SRC, 'pi/extension.ts'));

  it('reaches the health read it reports status from', () => {
    expect(parents.has(resolve(SRC, 'api/health.ts'))).toBe(true);
  });

  for (const forbidden of FORBIDDEN) {
    it(`does not load ${forbidden} into the Pi host`, () => {
      const target = resolve(SRC, forbidden);
      expect(parents.has(target), parents.has(target) ? chain(parents, target) : '').toBe(false);
    });
  }
});
