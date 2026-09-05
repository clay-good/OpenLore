/**
 * fix-windows-git-spawn-console-flash (and its predecessor, the windowsHide
 * spawn-site fixes) — the structural guard against the OTHER half of the
 * Windows console-flash bug class: `spawn(..., { detached: true })` without
 * `windowsHide: true`.
 *
 * `detached: true` alone is exactly the shape that surfaces a brand new visible
 * console window on Windows when the spawning process has no console of its own
 * (the serve/mcp daemon, a Claude Code hook invocation, the Pi extension host).
 * This shipped six times in one PR (mcp-watcher.ts x2, cold-start-bootstrap.ts,
 * decisions.ts, gryph-bridge.ts, view.ts) and stayed green through CI, because
 * a headless Windows runner cannot observe a window flashing — nothing failed
 * the build. This guard makes the fix a structural invariant instead of a
 * per-site discipline: `windowsHide: true` MUST appear in the same options
 * object as `detached: true`, checked on every platform (not just Windows), so
 * a regression fails CI everywhere instead of only being visible on a human's
 * Windows desktop.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..'); // src/

/** Every `.ts` under src/, excluding tests. */
function tsSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'fixtures') continue;
      out.push(...tsSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

const DETACHED_TOKEN = /detached\s*:\s*true/;
const WINDOWS_HIDE_TOKEN = /windowsHide\s*:\s*true/;

describe('windowsHide guard for detached spawns (structural invariant)', () => {
  it('every `detached: true` spawn options object also sets `windowsHide: true`', () => {
    const violations: string[] = [];

    for (const file of tsSourceFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf-8');
      if (!DETACHED_TOKEN.test(text)) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!DETACHED_TOKEN.test(lines[i])) continue;
        // The options object is usually a few lines wide around the `detached`
        // key — a small window in both directions covers every known shape
        // (single-line object, or one key per line) without needing a real
        // parser, matching the precision level of the existing gitPathArgs guard.
        const windowText = lines.slice(Math.max(0, i - 5), i + 6).join('\n');
        if (WINDOWS_HIDE_TOKEN.test(windowText)) continue;
        const rel = file.slice(SRC_ROOT.length + 1);
        violations.push(`${rel}:${i + 1}  ${lines[i].trim()}`);
      }
    }

    expect(
      violations,
      `\`detached: true\` spawn(s) without a nearby \`windowsHide: true\` — on Windows, a console ` +
        `subprocess spawned from a process with no console of its own gets a brand new visible ` +
        `window unless windowsHide is set. Add \`windowsHide: true\` to the same options object:\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('the guard actually detects an unguarded detached spawn (negative control)', () => {
    const bad = `spawn(cli, args, { cwd, stdio: 'ignore', detached: true });`;
    const good = `spawn(cli, args, { cwd, stdio: 'ignore', detached: true, windowsHide: true });`;
    expect(DETACHED_TOKEN.test(bad) && !WINDOWS_HIDE_TOKEN.test(bad)).toBe(true);
    expect(DETACHED_TOKEN.test(good) && WINDOWS_HIDE_TOKEN.test(good)).toBe(true);
  });
});
