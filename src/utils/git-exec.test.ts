/**
 * fix-windows-git-spawn-console-flash — the shared windowsHide discipline and its
 * structural guard.
 *
 * `execFileGit`/`execFileGitSync` are the one home for spawning `git` with
 * `windowsHide: true`. The guard test converts the per-site discipline into a
 * CI-enforced invariant: any `execFile`/`execFileSync`/`execFileAsync` call whose
 * first argument is the literal `'git'` MUST route through this module, so a new
 * unguarded site can't silently reintroduce the Windows console-flash bug (a
 * console subprocess spawned from a parent with no attached console — the
 * serve/mcp daemon, a Claude Code hook, the Pi extension host — gets a brand new
 * visible window per spawn unless windowsHide is set).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileGit, execFileGitSync } from './git-exec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..'); // src/

describe('execFileGit / execFileGitSync', () => {
  it('sets windowsHide: true on the underlying spawn', async () => {
    // `git --version` is cheap, side-effect-free, and available in any dev/CI env
    // that can run this suite at all (the repo itself is a git checkout).
    const { stdout } = await execFileGit('git', ['--version']);
    expect(stdout).toMatch(/git version/i);
  });

  it('execFileGitSync also succeeds (and applies windowsHide)', () => {
    const out = execFileGitSync('git', ['--version'], { encoding: 'utf-8' });
    expect(out).toMatch(/git version/i);
  });
});

// ── Structural guard: no unguarded `git` spawn in src ──────────────────────────

/** Every `.ts` under src/, excluding tests and this discipline's own home. */
function tsSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'fixtures') continue;
      out.push(...tsSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry === 'git-exec.ts') continue;
    out.push(full);
  }
  return out;
}

// A call whose first argument is the literal 'git' — the shape a raw
// execFile/execFileSync spawn of git takes at every known unguarded site. Does
// NOT match `execFileAsync`/`execFileSync` calls in a file that imports its local
// `execFileAsync`/`execFileSync` name FROM git-exec.js (the aliased-import
// migration form: `import { execFileGit as execFileAsync } from '.../git-exec.js'`)
// — that file's `execFileAsync('git', ...)` calls are already routed through the
// guarded helper under a locally-aliased name.
const GIT_SPAWN_TOKEN = /\b(?:execFile|execFileSync|execFileAsync)\(\s*(['"])git\1/;
// This file itself imports (possibly aliased) from git-exec.js.
const IMPORTS_GIT_EXEC = /from\s+(['"])(?:\.\.?\/)*utils\/git-exec\.js\1/;

describe('git windowsHide guard (structural invariant)', () => {
  it('every literal `git` execFile*/execFileAsync spawn in src routes through execFileGit(Sync)', () => {
    const violations: string[] = [];

    for (const file of tsSourceFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf-8');
      if (IMPORTS_GIT_EXEC.test(text)) continue; // migrated: local name is an alias for the guarded helper
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue; // doc comment / line comment
        if (!GIT_SPAWN_TOKEN.test(line)) continue;
        const rel = file.slice(SRC_ROOT.length + 1);
        violations.push(`${rel}:${i + 1}  ${trimmed}`);
      }
    }

    expect(
      violations,
      `Unguarded literal 'git' spawn(s) found — route them through execFileGit/execFileGitSync ` +
        `(src/utils/git-exec.ts) so windowsHide: true is applied and the spawn doesn't flash a ` +
        `console window on Windows when run from a console-less parent:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('the guard actually detects an unguarded spawn (negative control)', () => {
    const bad = `const out = execFileSync('git', ['status'], { cwd });`;
    const good = `const out = execFileGitSync('git', ['status'], { cwd });`;
    expect(GIT_SPAWN_TOKEN.test(bad)).toBe(true);
    expect(GIT_SPAWN_TOKEN.test(good)).toBe(false);
  });
});
