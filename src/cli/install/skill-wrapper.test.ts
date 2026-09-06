/**
 * Sanity tests for the `skills/openlore-orient/scripts/orient-via-mcp.mjs`
 * helper. We don't shell out (slow + flaky in CI without a built dist) — we
 * import the module and assert it does basic input validation and that the
 * file is structurally a JSON-RPC driver. End-to-end coverage of the actual
 * MCP roundtrip is exercised by hand against the local dist build and is
 * documented in the spec-02 PR description.
 */

import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const HELPER = resolve(REPO_ROOT, 'skills/openlore-orient/scripts/orient-via-mcp.mjs');
const SH = resolve(REPO_ROOT, 'skills/openlore-orient/scripts/orient.sh');
const PS1 = resolve(REPO_ROOT, 'skills/openlore-orient/scripts/orient.ps1');
const SKILL_MD = resolve(REPO_ROOT, 'skills/openlore-orient/SKILL.md');

describe('openlore-orient skill bundle', () => {
  it('orient-via-mcp.mjs exists and references the MCP server', async () => {
    const src = await readFile(HELPER, 'utf8');
    expect(src).toContain("'openlore'");
    expect(src).toContain("'mcp'");
    expect(src).toContain("'node_modules', 'npm', 'bin', 'npx-cli.js'");
    expect(src).toContain('tools/call');
    expect(src).toContain('initialize');
  });

  it('orient.sh prefers the CLI subcommand, falls back to MCP helper', async () => {
    const src = await readFile(SH, 'utf8');
    expect(src).toContain('npx --yes openlore orient --json --task');
    expect(src).toContain('orient-via-mcp.mjs');
  });

  it('orient.ps1 mirrors the same strategy', async () => {
    const src = await readFile(PS1, 'utf8');
    expect(src).toContain('npx --yes openlore orient --json --task');
    expect(src).toContain('orient-via-mcp.mjs');
  });

  it('SKILL.md has portable Agent Skills frontmatter', async () => {
    // Line endings normalised at the read: the frontmatter fences and the `^…$`
    // field patterns below are spelled with `\n`, and a CRLF checkout (the Windows
    // default) makes every one of them miss. The property is which keys the
    // frontmatter declares, not how the repository stores its newlines.
    const src = (await readFile(SKILL_MD, 'utf8')).split('\r\n').join('\n');
    const frontmatter = src.match(/^---\n([\s\S]*?)\n---/)?.[1];
    expect(frontmatter).toBeDefined();
    expect(src).toMatch(/^name:\s*openlore-orient$/m);
    expect(src).toMatch(/^description:\s*.+Use when.+$/m);
    expect(frontmatter?.split('\n').map((line) => line.split(':', 1)[0])).toEqual([
      'name',
      'description',
    ]);
    expect(src.toLowerCase()).toContain('deterministic, graph-native model');
  });

  it('orient.sh and orient.ps1 are executable', async () => {
    // Windows has no POSIX execute bit — `stat().mode` there reports a synthesised
    // value with no `0o111` information at all, so the working-copy check cannot
    // exist. The property that actually ships is the mode RECORDED IN GIT (`100755`),
    // which is what a POSIX checkout and the npm tarball both take their bit from,
    // and git records it identically on every platform. Assert that instead of
    // skipping, so the guard still runs on Windows.
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'git',
        ['ls-files', '--stage', '--', 'skills/openlore-orient/scripts/orient.sh',
          'skills/openlore-orient/scripts/orient.ps1'],
        { cwd: REPO_ROOT },
      );
      const modes = stdout.trim().split(/\r?\n/).map((line) => line.split(' ')[0]);
      expect(modes).toHaveLength(2);
      for (const mode of modes) expect(mode).toBe('100755');
      return;
    }
    const sh = await stat(SH);
    expect(sh.mode & 0o111).not.toBe(0);
    const ps1 = await stat(PS1);
    expect(ps1.mode & 0o111).not.toBe(0);
  });
});
