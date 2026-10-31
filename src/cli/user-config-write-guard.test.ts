/**
 * OnlyAHumanRunCommandWritesUserConfiguration (change: upgrade-repo-only-wiring).
 *
 * User-level agent configuration (`~/.claude.json`, `~/.claude/settings.json`, …) is
 * written only by the install machinery under `src/cli/install/`, reached from
 * human-run commands (`install`, `connect`, `setup`, `doctor --fix`, `update`). The
 * entry points an agent drives — the wired hooks, the MCP server, the serve daemon,
 * the Pi extension and auto-initialization — must not be able to reach it at all.
 *
 * Structural, so it holds for every code path rather than the few a behavioral test
 * would exercise: the full static and dynamic import closure of each entry point must
 * contain no install writer. `wiring-scope.ts` is the one read-only module there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]cli$/, '');

const AGENT_DRIVEN_ENTRY_POINTS = [
  'cli/commands/orient.ts', // SessionStart hook (`orient --json`) and UserPromptSubmit (`orient --inject`)
  'cli/commands/orient-inject.ts',
  'cli/commands/statusline.ts', // status-line hook
  'cli/commands/check-edit.ts',
  'cli/commands/mcp.ts', // MCP server
  'cli/commands/serve.ts', // serve daemon
  'pi/extension.ts', // Pi extension hooks
  'core/services/cold-start-bootstrap.ts', // auto-initialization
];

const READ_ONLY_INSTALL_MODULES = new Set(['cli/install/wiring-scope.ts']);

const SPECIFIER = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every repository module reachable from `entry`, with the importer that first reached it. */
function importClosure(entry: string): Map<string, string | null> {
  const reached = new Map<string, string | null>([[entry, null]]);
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    const source = readFileSync(join(SRC, file), 'utf8');
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith('.')) continue;
      const base = relative(SRC, resolve(dirname(join(SRC, file)), specifier)).split('\\').join('/');
      const target = [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base]
        .find(candidate => existsSync(join(SRC, candidate)));
      if (!target || reached.has(target)) continue;
      reached.set(target, file);
      stack.push(target);
    }
  }
  return reached;
}

describe('only a human-run command writes user configuration', () => {
  it.each(AGENT_DRIVEN_ENTRY_POINTS)('%s cannot reach the install writers', (entry) => {
    expect(existsSync(join(SRC, entry)), `${entry} moved; update this guard`).toBe(true);
    const closure = importClosure(entry);
    const writers = [...closure.keys()].filter(
      file => file.startsWith('cli/install/') && !READ_ONLY_INSTALL_MODULES.has(file),
    );
    const chains = writers.map((writer) => {
      const chain: string[] = [];
      for (let at: string | null | undefined = writer; at; at = closure.get(at)) chain.push(at);
      return chain.join(' <- ');
    });
    expect(chains, `src/${entry} can reach a user-scope writer`).toEqual([]);
  });
});
