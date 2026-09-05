/**
 * The general structural invariant behind the Windows console-flash bug class.
 *
 * `windowsHide` defaults to FALSE in Node. Spawning a console program from a parent that has no
 * console of its own — the `openlore serve`/`mcp` daemon, a Claude Code hook invocation
 * (`orient --inject`, which fires on every user turn once installed), the Pi extension host — then
 * gets a brand new visible console window, one per spawn. A path that shells out per file turns
 * that into a storm of flashing windows.
 *
 * Two guards already cover slices of this: `git-exec.test.ts` (every `git` spawn routes through the
 * shared helper) and `windows-detached-spawn-guard.test.ts` (`detached: true` implies
 * `windowsHide`). Neither is the whole class. The first only matched the `execFile*` shapes, so
 * three raw `spawn`/`spawnSync` calls of `git` slipped past it — two of them inside MCP handlers, on
 * the daemon path the fix was written for. The second only fires on `detached`, and the flash needs
 * no `detached` at all.
 *
 * So this guard states the invariant directly and shape-independently: EVERY subprocess spawned
 * from `src/` sets `windowsHide: true`, unless it inherits the parent's console.
 *
 * WHY `stdio: 'inherit'` IS THE ONE EXEMPTION, not an oversight. An inheriting child is by
 * construction attached to the console its parent already has, so no new window is created and
 * there is nothing to hide. Forcing `CREATE_NO_WINDOW` on those would be actively wrong: they are
 * the interactive re-entry paths (`heap-sizing`'s re-exec of the user's own command, `preflight`'s
 * re-analyze, `update`'s package-manager run) whose prompts and progress output must keep reaching
 * the real console.
 *
 * The scan is IMPORT-AWARE rather than name-based: it resolves which local identifiers are bound to
 * `node:child_process` and matches only calls to those. That is what keeps it honest in both
 * directions — no false positive on the hundreds of `regex.exec(...)` / `db.exec(...)` method calls
 * that a name-based scan drowns in, and no false negative on an aliased import
 * (`import { spawn as launch }`), which is exactly how a future regression would arrive.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..'); // src/

/** The `node:child_process` functions that start a process. */
const SPAWNING_EXPORTS = new Set([
  'spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork',
]);

/**
 * `src/utils/git-exec.ts` is the guarded home itself: it applies `windowsHide` to the call it
 * wraps, so its own `spawn(...)` bodies are the fix, not a violation.
 */
const EXEMPT_FILES = new Set(['utils/git-exec.ts']);

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
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Blank out comments — and, when `strings` is set, string bodies too — preserving every byte offset
 * and newline.
 *
 * Length-preserving so reported line numbers stay true, and so the balanced-paren scan below can
 * run over masked text while slicing argument text out of the ORIGINAL.
 *
 * The two modes exist because the import specifier `'node:child_process'` is ITSELF a string
 * literal: masking strings before resolving bindings erases the very thing being matched, and the
 * scan then reports a clean tree because it found no spawners at all. Bindings are read from
 * comment-masked source; call sites are scanned with strings masked too, so a `)` or a `//` inside
 * a literal cannot end a call early. The vacuity test at the bottom is what catches this if the two
 * are ever conflated again.
 */
export function maskComments(source: string, strings: boolean): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop - 1;
    } else if (strings && (c === '"' || c === "'" || c === '`')) {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') j++;
        j++;
      }
      blank(i + 1, j);
      i = j;
    }
  }
  return out.join('');
}

/** Local identifiers in this file bound to a process-starting `node:child_process` export. */
export function childProcessBindings(commentMasked: string): Set<string> {
  const locals = new Set<string>();
  const re = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]node:child_process['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(commentMasked)) !== null) {
    for (const clause of m[1].split(',')) {
      const trimmed = clause.trim();
      if (!trimmed) continue;
      const [importedRaw, localRaw] = trimmed.split(/\s+as\s+/);
      const imported = importedRaw.replace(/^type\s+/, '').trim();
      if (SPAWNING_EXPORTS.has(imported)) locals.add((localRaw ?? importedRaw).trim());
    }
  }
  return locals;
}

/** The argument-list text of the call whose `(` sits at `openIdx`, scanned over masked source. */
function callArguments(masked: string, original: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') {
      depth--;
      if (depth === 0) return original.slice(openIdx + 1, i);
    }
  }
  return original.slice(openIdx + 1);
}

interface Violation { file: string; line: number; text: string }

/** Every spawning call in one file that neither hides its window nor inherits a console. */
export function unhiddenSpawns(relPath: string, source: string): Violation[] {
  const masked = maskComments(source, true);
  const locals = childProcessBindings(maskComments(source, false));
  if (locals.size === 0) return [];

  const found: Violation[] = [];
  for (const local of locals) {
    // Not preceded by `.`, a word char or `$` — so `regex.exec(...)` and `db.exec(...)` never match.
    const re = new RegExp(`(^|[^.\\w$])${local}\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const args = callArguments(masked, source, openIdx);
      if (/windowsHide\s*:\s*true/.test(args)) continue;
      if (/stdio\s*:\s*(['"`])inherit\1/.test(args)) continue;
      found.push({
        file: relPath,
        line: source.slice(0, openIdx).split('\n').length,
        text: `${local}(${args.split('\n')[0].trim().slice(0, 90)}`,
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * Every spawning call in one file whose first argument is the literal `'git'`.
 *
 * The companion invariant to the one above, and the reason it lives here rather than beside
 * `git-exec.ts`: it needs the same import-aware scanner. `src/utils/git-exec.ts` is the ONE home
 * for spawning `git`, so `windowsHide` (and any future cross-cutting concern — env scrubbing, a
 * timeout floor) is applied in a single place instead of re-remembered at 30-odd call sites.
 *
 * Import-awareness is what makes this sound. The migrated sites import the helper under a local
 * alias (`import { execFileGit as execFileAsync }`), so their `execFileAsync('git', …)` calls are
 * already routed and must not be flagged. The previous version of this guard achieved that by
 * skipping any FILE that imported `git-exec.js` at all — which quietly exempted all 30 migrated
 * files, precisely the ones most likely to grow the next `git` spawn. Resolving bindings instead of
 * whole files closes that: an alias of the guarded helper is simply not a `node:child_process`
 * binding, while a fresh raw import in the same file is.
 */
export function unroutedGitSpawns(relPath: string, source: string): Violation[] {
  const masked = maskComments(source, true);
  const locals = childProcessBindings(maskComments(source, false));
  if (locals.size === 0) return [];

  const found: Violation[] = [];
  for (const local of locals) {
    const re = new RegExp(`(^|[^.\\w$])${local}\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      // First argument read from the ORIGINAL text: the literal is masked out of `masked`.
      const args = callArguments(masked, source, openIdx);
      if (!/^\s*(['"`])git\1\s*(?:,|$)/.test(args)) continue;
      found.push({
        file: relPath,
        line: source.slice(0, openIdx).split('\n').length,
        text: `${local}(${args.split('\n')[0].trim().slice(0, 90)}`,
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

describe('windowsHide guard for every spawn (structural invariant)', () => {
  it('every subprocess spawned in src sets windowsHide, or inherits the console', () => {
    const violations: string[] = [];
    for (const file of tsSourceFiles(SRC_ROOT)) {
      const rel = file.slice(SRC_ROOT.length + 1).replace(/\\/g, '/');
      if (EXEMPT_FILES.has(rel)) continue;
      for (const v of unhiddenSpawns(rel, readFileSync(file, 'utf-8'))) {
        violations.push(`${v.file}:${v.line}  ${v.text}`);
      }
    }

    expect(
      violations,
      `Subprocess spawn(s) without \`windowsHide: true\` — on Windows, a console program spawned ` +
        `from a parent with no console of its own (the serve/mcp daemon, a Claude Code hook, the ` +
        `Pi extension host) gets a brand new visible window per spawn. Add \`windowsHide: true\` ` +
        `to the options object — it is a documented no-op on macOS/Linux. For a \`git\` spawn, ` +
        `route it through src/utils/git-exec.ts instead, which applies it for you. If the child ` +
        `must stay attached to the user's terminal, give it \`stdio: 'inherit'\` and say why:\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('flags an unguarded spawn, and accepts the two legitimate shapes (negative control)', () => {
    const bad = `import { spawn } from 'node:child_process';\nspawn('git', ['status'], { cwd });`;
    expect(unhiddenSpawns('x.ts', bad)).toHaveLength(1);

    const hidden = `import { spawn } from 'node:child_process';\nspawn('git', ['status'], { cwd, windowsHide: true });`;
    expect(unhiddenSpawns('x.ts', hidden)).toEqual([]);

    const inherits = `import { spawn } from 'node:child_process';\nspawn('git', ['status'], { cwd, stdio: 'inherit' });`;
    expect(unhiddenSpawns('x.ts', inherits)).toEqual([]);
  });

  it('follows an aliased import — the shape a regression actually arrives in', () => {
    const aliased = `import { spawn as launch } from 'node:child_process';\nlaunch('git', ['status'], { cwd });`;
    expect(unhiddenSpawns('x.ts', aliased)).toHaveLength(1);
  });

  it('never matches a method call named like a child_process export', () => {
    // `.exec` on a regex or a SQLite handle is the overwhelming majority of `exec(` in this repo;
    // a name-based scan reports hundreds of them and is therefore unusable as a gate.
    const methods = `import { exec } from 'node:child_process';
      while ((m = re.exec(source)) !== null) {}
      db.exec('VACUUM');
      this.db.exec(\`DELETE FROM nodes\`);`;
    expect(unhiddenSpawns('x.ts', methods)).toEqual([]);
  });

  it('does not read a spawn out of a comment or a string literal', () => {
    const quoted = `import { spawn } from 'node:child_process';
      /** Usage: spawn('git', args, { cwd }) — replaced by the helper. */
      // spawn('git', ['log'], { cwd });
      const sample = "spawn('git', ['log'], { cwd })";`;
    expect(unhiddenSpawns('x.ts', quoted)).toEqual([]);
  });

  it('is not vacuous — it does resolve bindings in the real tree', () => {
    const withBindings = tsSourceFiles(SRC_ROOT).filter(
      f => childProcessBindings(maskComments(readFileSync(f, 'utf-8'), false)).size > 0,
    );
    expect(withBindings.length).toBeGreaterThan(5);
  });
});

describe('git spawns route through git-exec (structural invariant)', () => {
  it('no raw node:child_process spawn of `git` survives outside the helper', () => {
    const violations: string[] = [];
    for (const file of tsSourceFiles(SRC_ROOT)) {
      const rel = file.slice(SRC_ROOT.length + 1).replace(/\\/g, '/');
      if (EXEMPT_FILES.has(rel)) continue;
      for (const v of unroutedGitSpawns(rel, readFileSync(file, 'utf-8'))) {
        violations.push(`${v.file}:${v.line}  ${v.text}`);
      }
    }

    expect(
      violations,
      `Raw \`git\` spawn(s) found — route them through src/utils/git-exec.ts ` +
        `(execFileGit / execFileGitSync / spawnGit / spawnGitSync) so windowsHide: true is applied ` +
        `in one place and the spawn cannot flash a console window on Windows:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('flags a raw git spawn but not the aliased helper (negative control)', () => {
    const raw = `import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['status'], { cwd });`;
    expect(unroutedGitSpawns('x.ts', raw)).toHaveLength(1);

    const routed = `import { execFileGit as execFileAsync } from '../utils/git-exec.js';\nexecFileAsync('git', ['status'], { cwd });`;
    expect(unroutedGitSpawns('x.ts', routed)).toEqual([]);

    // The hole this replaced: one migrated alias in a file no longer exempts a raw spawn beside it.
    const mixed = `import { execFileGit as execFileAsync } from '../utils/git-exec.js';
      import { spawnSync } from 'node:child_process';
      execFileAsync('git', ['log'], { cwd });
      spawnSync('git', ['rev-parse', 'HEAD'], { cwd });`;
    expect(unroutedGitSpawns('x.ts', mixed)).toHaveLength(1);
  });

  it('does not flag a spawn of something else', () => {
    const other = `import { spawnSync } from 'node:child_process';\nspawnSync('gh', ['pr', 'list'], { cwd });`;
    expect(unroutedGitSpawns('x.ts', other)).toEqual([]);
  });
});
